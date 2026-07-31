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

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, postRenderJobs, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import type { Overlay } from './overlay-geometry';
import { renderableAudio } from './audio-overlays';

type Db = ReturnType<typeof getDb>;

export interface VideoBase {
    assetId: number;
    storageKey: string | null;
    externalUrl: string | null;
    mimeType: string;
    width: number | null;
    height: number | null;
    /**
     * 'video' is the original case. 'image' exists because AUDIO made stills renderable: no platform
     * accepts a photo with sound, so an image + voice note has to be rendered together into an mp4.
     * The caller must branch — a still goes to the composition as imageSrc, not videoSrc.
     */
    kind: 'video' | 'image';
}

// Overlays worth rendering: a box with no text is invisible, and rendering for zero visible boxes
// would burn a Lambda render to reproduce the original clip byte-for-worse.
export function renderableOverlays(raw: unknown): Overlay[] {
    if (!Array.isArray(raw)) return [];
    return (raw as Overlay[]).filter(o => o && String(o.text || '').trim());
}

/**
 * A stable fingerprint of an overlay design — "which words, where, in what style".
 *
 * ── What this is for ────────────────────────────────────────────────────────────────────────────
 * A PHOTO's overlays are burned in by the browser (see trigger-post-render.ts: the canvas has the
 * fonts, so it is faster, free and font-perfect). The result is uploaded as a NEW flattened asset
 * and attached with keepOverlays:true, which leaves `image_overlays` and the `overlay_base_asset_id`
 * pin in place so the design stays editable.
 *
 * That is what makes "has this been baked?" unanswerable from the post row alone: a baked post and
 * an un-baked one look identical — both carry overlays and a base pin. Worse, a post baked and THEN
 * edited also looks baked, so a stale flattened image would publish with the old words on it.
 *
 * So the bake stamps its output asset with this fingerprint (content_assets.render_params), and
 * approve-post compares it against the post's current design. Equal means the attached image really
 * is this design flattened; anything else — absent, or from an older design — means it is not.
 *
 * The field list is the Overlay interface in overlay-geometry.ts, MINUS `id`. Take it from that
 * interface rather than from memory: a field omitted here is a change the bake silently ignores, so
 * restyling a box leaves the stale flattened image reading as current and the old pixels publish.
 * Written from memory the first time, this hashed fontSize/fontWeight/align/w/h — none of which
 * exist — while missing fontSizePct, boxStroke, boxFill and boxOpacity, which are precisely the
 * restyling controls. tests/brand-card.test.ts now varies each field on its own.
 *
 * `id` is excluded because it is a client-generated handle that can
 * change without the picture changing, and including it would force a re-bake on every reopen.
 * Everything that alters a pixel is in, and nothing else is.
 */
export function overlaysFingerprint(raw: unknown): string {
    const parts = renderableOverlays(raw).map((o: any) => [
        String(o.text ?? ''),
        o.x ?? '', o.y ?? '',
        o.fontFamily ?? '', o.fontSizePct ?? '', o.color ?? '',
        o.boxStroke ?? '', o.boxFill ?? '', o.boxOpacity ?? '',
        // Timing changes nothing on a still, but a photo+audio post renders as video where it does.
        o.startS ?? '', o.endS ?? '',
    ].join('\u001f'));
    // Order matters — overlays paint in array order, so a reorder can change what covers what.
    const src = parts.join('\u001e');
    // Same cheap stable hash as hashCaption in post-quality-review.ts; this only has to detect
    // CHANGE, and it is compared against a value produced by this very function.
    let h = 0;
    for (let i = 0; i < src.length; i++) { h = (Math.imul(31, h) + src.charCodeAt(i)) | 0; }
    return `${renderableOverlays(raw).length}:${(h >>> 0).toString(36)}`;
}

/** What the overlay bake writes into its flattened asset's render_params. */
export interface OverlayBakeStamp {
    kind: 'overlay_bake';
    postId: number;
    overlaysHash: string;
    at: string;
}

/**
 * True when `renderParams` says this asset is the given post's CURRENT overlay design, flattened.
 *
 * Fails closed on anything unexpected: an asset with no stamp, a stamp for another post, or a stamp
 * from an older design all return false, because every one of them means the pixels on screen are
 * not the pixels the reviewer approved.
 */
export function isBakedFor(renderParams: unknown, postId: number, overlays: unknown): boolean {
    const rp = renderParams as Partial<OverlayBakeStamp> | null | undefined;
    if (!rp || rp.kind !== 'overlay_bake') return false;
    if (Number(rp.postId) !== Number(postId)) return false;
    return rp.overlaysHash === overlaysFingerprint(overlays);
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
    const type = (asset?.assetType ?? '').toLowerCase();
    if (!asset || (type !== 'video' && type !== 'image')) return null;
    if (!asset.storageKey && !asset.externalUrl) return null;

    return {
        assetId: asset.id,
        storageKey: asset.storageKey,
        externalUrl: asset.externalUrl,
        mimeType: asset.mimeType || (type === 'video' ? 'video/mp4' : 'image/jpeg'),
        width: asset.width,
        height: asset.height,
        kind: type === 'video' ? 'video' : 'image',
    };
}

/** An audio clip resolved to something Lambda can fetch. */
export interface ResolvedAudio {
    id: string;
    src: string;
    startS?: number;
    endS?: number;
    volume: number;
    fadeInS?: number;
    fadeOutS?: number;
}

/**
 * Turn the stored audio arrangement into fetchable tracks for the composition.
 *
 * Scoped to the org on purpose, even though save-post-audio already checked: the renderer runs with
 * full R2 credentials and no tenant context, so this is the last place a cross-tenant asset id could
 * be caught before its bytes are fetched and published. Clips whose asset has vanished are dropped
 * rather than failing the render — losing one voice note beats losing the whole post.
 *
 * The 1-hour presign matches the video source: Lambda streams these across the render, and a
 * 10-minute URL can expire mid-encode.
 */
export async function resolveAudioTracks(
    db: Db, raw: unknown, orgId: number,
    presign: (key: string, ttl: number) => Promise<string>,
): Promise<ResolvedAudio[]> {
    const overlays = renderableAudio(raw);
    if (!overlays.length) return [];

    const ids = [...new Set(overlays.map(a => a.assetId))];
    const rows = await db
        .select({ id: contentAssets.id, assetType: contentAssets.assetType, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
        .from(contentAssets)
        .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
    const byId = new Map(rows.filter(r => (r.assetType ?? '').toLowerCase() === 'audio').map(r => [r.id, r]));

    const out: ResolvedAudio[] = [];
    for (const a of overlays) {
        const asset = byId.get(a.assetId);
        if (!asset) continue;
        let src: string | null = null;
        if (asset.storageKey) { try { src = await presign(asset.storageKey, AUDIO_URL_TTL_SEC); } catch { /* fall through */ } }
        if (!src) src = asset.externalUrl ?? null;
        if (!src) continue;
        out.push({
            id: a.id, src,
            volume: a.volume == null ? 1 : a.volume,
            ...(a.startS != null ? { startS: a.startS } : {}),
            ...(a.endS != null ? { endS: a.endS } : {}),
            ...(a.fadeInS != null ? { fadeInS: a.fadeInS } : {}),
            ...(a.fadeOutS != null ? { fadeOutS: a.fadeOutS } : {}),
        });
    }
    return out;
}

const AUDIO_URL_TTL_SEC = 3600;

// Frame metadata for the composition. Defaults exist because none of it is guaranteed: content_assets
// stores width/height only for some providers and never a duration, and the client's numbers come off
// a <video> element that may not have finished loading metadata. A wrong-but-sane frame gives a
// slightly letterboxed render; a NaN one gives a Lambda error 40 seconds into the job.
export const RENDER_FPS = 30;              // fixed: OffthreadVideo samples the source by time, so the
                                           // output fps need not match the input's.
export const MAX_RENDER_SECONDS = 600;     // 10 min — well past any social clip, and a guard against a
                                           // junk duration queueing an hours-long render.

export interface FrameMeta { width: number; height: number; fps: number; durationInFrames: number; }

/**
 * The render job's snapshot: the frame metadata, plus WHY the render exists.
 *
 * `forceVideo` marks a render whose point is the container, not the burn-in. An autonomous YouTube
 * Short is a brand card — a still, with its words already drawn into the image — and YouTube has no
 * image post, so the still must become an mp4 even though there is nothing to overlay onto it. The
 * worker's "no overlays, nothing to do" bail-out is correct for every other caller and fatal for
 * this one, so the reason has to travel with the job rather than be re-derived from the post.
 */
export interface RenderJobInput extends FrameMeta { forceVideo?: boolean }

/** True when this job must produce a video even with nothing to burn in. Defensive: old rows have no flag. */
export function readForceVideo(raw: unknown): boolean {
    return !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>).forceVideo === true);
}

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

    // post_format has to move with the media. It did not, and that was a silent publish bug:
    // publish-instagram.ts decides IMAGE vs REELS purely from post_format, so a photo post that
    // gained a voice note (and was therefore rendered into an mp4) was still described as an
    // 'image' — Instagram was handed media_type: 'IMAGE' pointing at an mp4 and rejected it, while
    // the reviewer saw nothing wrong. A post that IS a video must say so.
    //
    // A format that is already video-ish is left alone: 'reel' is more specific than 'video' and
    // overwriting it would flatten a Reel into a plain video post.
    const [current] = await db
        .select({ postFormat: scheduledPosts.postFormat })
        .from(scheduledPosts)
        .where(eq(scheduledPosts.id, postId))
        .limit(1);
    const alreadyVideo = ['reel', 'video', 'short'].includes((current?.postFormat ?? '').toLowerCase());

    await db.update(scheduledPosts)
        .set({
            contentAssetIds: [assetId],
            mediaMissing: false,
            mediaMissingNote: null,
            ...(alreadyVideo ? {} : { postFormat: 'video' }),
            updatedAt: new Date(),
        })
        .where(eq(scheduledPosts.id, postId));
}

/**
 * Queue a Remotion render for a post and dispatch the worker.
 *
 * Shared by trigger-post-render.ts (a reviewer pressing approve on a video with text) and the
 * autonomous Short drafter, which has no HTTP session to ride on. Both need the SAME failure
 * handling, and that is the real reason this is shared rather than copied: setting render_status
 * with nothing behind it strands the post permanently unpublishable — the publishers hold anything
 * that isn't 'done'. So a failed dispatch must un-gate the post, and a caller that forgets is a
 * silent, unrecoverable bug rather than a visible one.
 */
export async function queuePostRender(db: Db, opts: {
    orgId: number;
    postId: number;
    userId: number | null;
    input: RenderJobInput;
    /** Origin for the worker call. Null ⇒ nothing can be dispatched, so we refuse before gating. */
    baseUrl: string | null;
}): Promise<{ ok: true; jobId: number } | { ok: false; error: string }> {
    if (!opts.baseUrl) return { ok: false, error: 'No base URL — the render worker cannot be reached.' };

    const [job] = await db.insert(postRenderJobs).values({
        organisationId: opts.orgId,
        postId: opts.postId,
        userId: opts.userId,
        status: 'queued',
        renderInput: opts.input,
    }).returning({ id: postRenderJobs.id });

    await db.update(scheduledPosts)
        .set({ renderStatus: 'pending', updatedAt: new Date() })
        .where(eq(scheduledPosts.id, opts.postId));

    // MUST be awaited: Lambda freezes the execution environment when the handler returns, so an
    // un-awaited fetch never leaves the box and the job sits 'queued' forever behind a gated post.
    // The -background function returns 202 immediately, so awaiting costs only the round trip.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let dispatched = false;
    try {
        const res = await fetch(`${opts.baseUrl}/.netlify/functions/render-post-video-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: job.id }),
            signal: controller.signal,
        });
        dispatched = res.ok;
    } catch (err) {
        console.error('[queuePostRender] failed to trigger worker:', err);
    } finally {
        clearTimeout(timer);
    }

    if (!dispatched) {
        await db.update(postRenderJobs)
            .set({ status: 'failed', errorMessage: 'The render worker could not be reached.', updatedAt: new Date() })
            .where(eq(postRenderJobs.id, job.id));
        await db.update(scheduledPosts)
            .set({ renderStatus: null, updatedAt: new Date() })
            .where(eq(scheduledPosts.id, opts.postId));
        return { ok: false, error: 'Could not start the video render.' };
    }

    return { ok: true, jobId: job.id };
}
