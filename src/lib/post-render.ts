// src/lib/post-render.ts
//
// Shared bits of the video-overlay render pipeline, used by BOTH ends of it: trigger-post-render.ts
// (which queues the job) and render-post-video-background.ts (which runs it). They must agree on
// which asset is the base clip and which overlays count as renderable — if they disagree, the job is
// validated against one video and rendered against another.
//
// Why the worker re-resolves instead of trusting a snapshot: only the frame metadata is snapshotted
// on the job (post_render_jobs.render_input), because the client reads the clip's duration off the
// <video> element and it is stored nowhere. Everything else is re-derived at render time so a fresh
// presigned URL is minted (they expire) and a late overlay edit is picked up rather than rendering
// a stale design.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import type { Overlay } from './overlay-geometry';

type Db = ReturnType<typeof getDb>;

export interface VideoBase {
    assetId: number;
    storageKey: string | null;
    externalUrl: string | null;
    mimeType: string;
    width: number | null;
    height: number | null;
}

// Overlays worth rendering: a box with no text is invisible, and rendering for zero visible boxes
// would burn a Lambda render to reproduce the original clip byte-for-worse.
export function renderableOverlays(raw: unknown): Overlay[] {
    if (!Array.isArray(raw)) return [];
    return (raw as Overlay[]).filter(o => o && String(o.text || '').trim());
}

/**
 * The post's CLEAN base video — the clip the overlays were designed against.
 *
 * Mirrors get-post-image's resolution rule exactly: the pinned overlay_base_asset_id wins when set
 * (so a re-render composites onto the true original rather than onto an already-rendered copy), and
 * otherwise the post's first attached asset is used, junction table first with the deprecated
 * contentAssetIds array as the migration fallback.
 *
 * Returns null when the post has no attached asset, or when the asset it has is not a video — the
 * caller's cue that this is a photo post and belongs on the browser-bake path instead.
 */
export async function resolveOverlayVideoBase(db: Db, postId: number, orgId: number): Promise<VideoBase | null> {
    const [post] = await db
        .select({
            overlayBaseAssetId: scheduledPosts.overlayBaseAssetId,
            contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return null;

    let assetId: number | null = post.overlayBaseAssetId ?? null;
    if (assetId == null) {
        const junction = await db
            .select({ contentAssetId: scheduledPostAssets.contentAssetId, position: scheduledPostAssets.position })
            .from(scheduledPostAssets)
            .where(eq(scheduledPostAssets.scheduledPostId, postId));
        const ids = [
            ...junction.sort((a, b) => a.position - b.position).map(r => r.contentAssetId),
            ...(Array.isArray(post.contentAssetIds) ? (post.contentAssetIds as number[]) : []),
        ];
        assetId = [...new Set(ids)][0] ?? null;
    }
    if (assetId == null) return null;

    const [asset] = await db
        .select({
            id: contentAssets.id,
            assetType: contentAssets.assetType,
            mimeType: contentAssets.mimeType,
            storageKey: contentAssets.storageKey,
            externalUrl: contentAssets.externalUrl,
            width: contentAssets.width,
            height: contentAssets.height,
        })
        .from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId)))
        .limit(1);
    if (!asset || (asset.assetType ?? '').toLowerCase() !== 'video') return null;
    if (!asset.storageKey && !asset.externalUrl) return null;

    return {
        assetId: asset.id,
        storageKey: asset.storageKey,
        externalUrl: asset.externalUrl,
        mimeType: asset.mimeType || 'video/mp4',
        width: asset.width,
        height: asset.height,
    };
}

// Frame metadata for the composition. Defaults exist because none of it is guaranteed: content_assets
// stores width/height only for some providers and never a duration, and the client's numbers come off
// a <video> element that may not have finished loading metadata. A wrong-but-sane frame gives a
// slightly letterboxed render; a NaN one gives a Lambda error 40 seconds into the job.
export const RENDER_FPS = 30;              // fixed: OffthreadVideo samples the source by time, so the
                                           // output fps need not match the input's.
export const MAX_RENDER_SECONDS = 600;     // 10 min — well past any social clip, and a guard against a
                                           // junk duration queueing an hours-long render.

export interface FrameMeta { width: number; height: number; fps: number; durationInFrames: number; }

// Even dimensions only: h264 chroma subsampling requires them, and an odd width fails the encode at
// the very end of an otherwise successful render.
const even = (n: number) => (n % 2 === 0 ? n : n + 1);

export function frameMeta(input: { width?: unknown; height?: unknown; durationS?: unknown }, base: VideoBase): FrameMeta {
    const num = (v: unknown, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const width = even(Math.round(Math.min(4096, num(input.width, base.width || 1080))));
    const height = even(Math.round(Math.min(4096, num(input.height, base.height || 1920))));
    const seconds = Math.min(MAX_RENDER_SECONDS, num(input.durationS, 15));
    return {
        width,
        height,
        fps: RENDER_FPS,
        durationInFrames: Math.max(1, Math.round(seconds * RENDER_FPS)),
    };
}

// Narrow a stored render_input JSON back to a FrameMeta, defensively — the row may predate a field,
// or have been written by an older deploy.
export function frameMetaFromJson(raw: unknown): FrameMeta | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const width = n(r.width), height = n(r.height), fps = n(r.fps), durationInFrames = n(r.durationInFrames);
    if (!width || !height || !fps || !durationInFrames) return null;
    return { width, height, fps, durationInFrames };
}

// Assets referenced by a post, for the worker's swap. Exported here so the worker doesn't reach into
// the junction table's shape itself.
export async function attachRenderedVideo(db: Db, postId: number, assetId: number): Promise<void> {
    // Same swap attach-draft-media performs, but keeping the overlay design and the base pin: the
    // rendered clip REPLACES the visible media while overlay_base_asset_id still points at the clean
    // original, so reopening the post re-edits the original design rather than stacking text onto
    // already-burned text.
    await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, postId));
    await db.insert(scheduledPostAssets)
        .values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 })
        .onConflictDoNothing();
    await db.update(scheduledPosts)
        .set({ contentAssetIds: [assetId], mediaMissing: false, mediaMissingNote: null, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));
}
