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
import { DEFAULT_TARGET_RATIO, readVideoEdit, renderableClips, resolveClipGain, resolveTrim } from './video-edit';
import { reframeRatioFor } from '../utils/format-router';

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
        // How it arrives. Omitted, two siblings differing only in their animation would fingerprint
        // as identical and share one render — so one of them would publish the other's motion.
        o.anim ?? '',
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

/** One clip of the timeline, resolved to something Lambda can fetch. */
export interface ResolvedClip {
    id: string;
    /** The content_assets row this clip came from. Stable, unlike the presigned src. */
    assetId: number;
    src: string;
    /** Seconds into the source. Absent = the clip's own edge; the composition clamps both to the file. */
    inS?: number;
    outS?: number;
    /** 0..1 on the clip's own camera audio. Absent = leave it alone (the composition plays it at 1). */
    gain?: number;
}

/**
 * The post's timeline, in order, as fetchable clips.
 *
 * ── Why this replaces "the base clip" ───────────────────────────────────────────────────────────
 * resolveOverlayVideoBase answers "which single asset is this post's video", which was the only
 * question worth asking while a post had one. It still answers it — the overlay base PIN depends on
 * it, and a photo+audio render has no timeline at all — but it is no longer what gets rendered.
 * The edit list is, when there is one.
 *
 * Falling back to `[base]` when the post has no edit is what keeps every existing post rendering
 * exactly as before: one clip, no trim, same output. A post that has never been edited must not
 * notice that this pipeline grew a timeline.
 *
 * ── The org scope is not redundant ──────────────────────────────────────────────────────────────
 * save-post-video-edit already checked ownership, but the renderer runs with full R2 credentials and
 * no tenant context, so this is the last place a cross-tenant asset id can be stopped before its
 * bytes are fetched and published on someone else's account. Same reasoning as resolveAudioTracks.
 *
 * A clip whose asset has vanished is DROPPED, not fatal — losing one segment of a reel beats losing
 * the post. If every clip is gone the caller falls back to the base, and if that is gone too the
 * render fails loudly, which is correct: there is nothing to render.
 */
export async function resolveEditClips(
    db: Db,
    args: { videoEdit: unknown; orgId: number; base: VideoBase; hasTimelineAudio: boolean },
    presign: (key: string, ttl: number) => Promise<string>,
): Promise<ResolvedClip[]> {
    const { videoEdit, orgId, base, hasTimelineAudio } = args;

    const srcFor = async (storageKey: string | null, externalUrl: string | null): Promise<string | null> => {
        if (storageKey) { try { return await presign(storageKey, SOURCE_URL_TTL_SEC); } catch { /* fall through */ } }
        return externalUrl ?? null;
    };

    const clips = base.kind === 'video' ? renderableClips(videoEdit) : [];
    if (clips.length) {
        const ids = [...new Set(clips.map(c => c.assetId))];
        const rows = await db
            .select({ id: contentAssets.id, assetType: contentAssets.assetType, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
            .from(contentAssets)
            .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
        const byId = new Map(rows.filter(r => (r.assetType ?? '').toLowerCase() === 'video').map(r => [r.id, r]));

        const out: ResolvedClip[] = [];
        for (const clip of clips) {
            const asset = byId.get(clip.assetId);
            if (!asset) continue;
            const src = await srcFor(asset.storageKey, asset.externalUrl);
            if (!src) continue;
            // The trim is resolved with no known duration on purpose: content_assets stores none, so
            // the real length is measured inside the render and the bounds clamped there.
            const trim = resolveTrim(clip, null);
            const gain = resolveClipGain(clip, hasTimelineAudio);
            out.push({
                id: clip.id,
                assetId: clip.assetId,
                src,
                ...(trim?.inS ? { inS: trim.inS } : {}),
                ...(trim?.outS != null ? { outS: trim.outS } : {}),
                ...(gain != null ? { gain } : {}),
            });
        }
        if (out.length) return out;
    }

    // No edit, or nothing in it survived: render the post's own media, whole — and at its own
    // volume. The mute-under-audio default deliberately does NOT reach here: an ordinary video with
    // a voice note over it has played both since the day sound shipped, and re-mixing it on the next
    // render would be a silent change to a post nobody edited.
    const src = await srcFor(base.storageKey, base.externalUrl);
    return src ? [{ id: `base-${base.assetId}`, assetId: base.assetId, src }] : [];
}

const SOURCE_URL_TTL_SEC = 3600;

/**
 * Read a post's edit list WITHOUT naming the column in the caller's main select.
 *
 * `db.select({...})` lists every column it wants, so one missing column takes the whole query down —
 * and `video_edit` reaches production behind whatever deploy carries the code. Selecting it inline
 * would mean the code and the migration have to land in a fixed order, and getting that order wrong
 * does not degrade gracefully: every video post throws on both the trigger and the worker, and (once
 * the review queue reads it too) the queue renders empty.
 *
 * So it is read on its own and the failure is swallowed, exactly as get-social-drafts already does
 * for audio_overlays: an environment without the column behaves as though no post has been edited,
 * which is precisely how it behaved before the feature existed. The warning is there so a genuinely
 * broken environment is still findable in the logs rather than merely quiet.
 */
export async function readPostVideoEdit(db: Db, postId: number, orgId: number): Promise<unknown> {
    try {
        const [row] = await db
            .select({ videoEdit: scheduledPosts.videoEdit })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
            .limit(1);
        return row?.videoEdit ?? null;
    } catch (err) {
        console.warn('[post-render] video_edit unavailable — treating post as unedited:', err instanceof Error ? err.message : err);
        return null;
    }
}

/** The post fields the render plan is derived from. Select exactly these at both ends. */
export interface RenderPlanRow {
    id: number;
    platform: string | null;
    formatKey: string | null;
    imageOverlays: unknown;
    audioOverlays: unknown;
    videoEdit: unknown;
}

export interface RenderPlan {
    /** The ratio this post renders at. Null = inherit the source clip's own frame, as before. */
    targetRatio: string | null;
    /** Where the picture sits when the re-frame crops it. Null = centred / nothing overflows. */
    framePosition: { offsetX: number; offsetY: number } | null;
    /** True when this row is a re-frame of the master rather than the master itself. */
    reframed: boolean;
    fingerprint: string;
}

/**
 * The ratio the MASTER is cut to, or null when this post has no cut of its own.
 *
 * Null is the important case and it is not the same as "9:16": a post nobody has edited renders from
 * its single clip at that clip's own size, exactly as it did before any of this. Only an edit gives
 * the piece a frame of its own — and only a piece with a frame can be re-framed for a platform.
 *
 * Exported because the review queue asks the same question to draw the crop preview, and two answers
 * to "what shape is this post" would put the preview and the render out of step.
 */
export function masterRatioFor(videoEdit: unknown): string | null {
    const clips = renderableClips(videoEdit);
    if (!clips.length) return null;
    return readVideoEdit(videoEdit)?.targetRatio ?? (clips.length > 1 ? DEFAULT_TARGET_RATIO : null);
}

/**
 * What THIS post row should render, and what its output will look like.
 *
 * Called by the trigger (to decide whether a sibling is already rendering the same thing) and by the
 * worker (to build the render, and to decide who else may have its output). One function, because
 * two paths deriving render input independently is exactly what produced the silently un-gated Short
 * — see the comment block in trigger-post-render.ts.
 *
 * The master ratio only exists where there IS an edit. A post nobody has edited renders from its own
 * single clip at that clip's own size, exactly as it did before any of this — which is also why an
 * unedited post never re-frames: there is no master to re-frame, only someone's original video.
 */
export function renderPlanFor(post: RenderPlanRow, base: VideoBase, hasTimelineAudio: boolean): RenderPlan {
    const edit = readVideoEdit(post.videoEdit);
    const master = masterRatioFor(post.videoEdit);

    const reframe = master && post.platform
        ? reframeRatioFor(post.platform, post.formatKey, master)
        : null;

    const targetRatio = reframe ?? master;
    // Framing only means something where the picture actually overflows the frame, which is only on
    // a re-framed row. Carrying the offset onto the master too would put it in the fingerprint and
    // split siblings that render identical files.
    const framePosition = reframe && post.platform ? (edit?.frames?.[post.platform] ?? null) : null;

    return {
        targetRatio,
        framePosition,
        reframed: reframe != null,
        fingerprint: renderFingerprint({
            videoEdit: post.videoEdit,
            baseAssetId: base.assetId,
            hasTimelineAudio,
            imageOverlays: post.imageOverlays,
            audioOverlays: post.audioOverlays,
            targetRatio,
            framePosition,
        }),
    };
}

/** Everything about a post that decides what its rendered file looks like. Ids, never URLs. */
export interface RenderIdentity {
    videoEdit: unknown;
    baseAssetId: number;
    hasTimelineAudio: boolean;
    imageOverlays: unknown;
    audioOverlays: unknown;
    /** The ratio THIS post renders at — the master, or its platform's re-frame of it. */
    targetRatio?: string | null;
    framePosition?: { offsetX: number; offsetY: number } | null;
}

/**
 * A fingerprint of the file a render would produce.
 *
 * ── What it is for ──────────────────────────────────────────────────────────────────────────────
 * A cross-post is one edit across up to six platform rows, and four of them want the identical 9:16
 * file. Rendering it four times would ask for four times the Lambda budget we have — the account
 * cap is 10 concurrent and one render already spends up to 8 — so identical siblings must share one
 * render. This is how "identical" is decided.
 *
 * ── Why it hashes the whole input rather than a chosen subset ───────────────────────────────────
 * The dangerous version of this feature is one that shares a render between two posts that are NOT
 * identical: sibling B publishes with sibling A's text burned into it, and nothing anywhere reports
 * a problem. Text overlays are per-post by design (save-post-overlays defaults applyToGroup false),
 * so that divergence is normal, not exotic. Hashing everything that reaches the composition — and
 * only things that reach it — makes "same fingerprint" mean "same output" by construction, instead
 * of by a judgement about which fields matter that would be wrong the moment a field is added.
 *
 * Asset IDS, never the presigned URLs: those carry a signature and an expiry, so two renders of the
 * same file would never agree.
 */
export function renderFingerprint(identity: RenderIdentity): string {
    const clips = renderableClips(identity.videoEdit);
    const clipKey = clips.length
        ? clips.map(c => {
            const trim = resolveTrim(c, null);
            const gain = resolveClipGain(c, identity.hasTimelineAudio);
            return [c.assetId, trim?.inS ?? '', trim?.outS ?? '', gain ?? ''].join(',');
        }).join('|')
        // No edit: the post renders its own single asset, whole and at its own volume.
        : `base:${identity.baseAssetId}`;

    const audioKey = renderableAudio(identity.audioOverlays)
        .map(a => [a.assetId, a.startS ?? '', a.endS ?? '', a.volume, a.fadeInS ?? '', a.fadeOutS ?? ''].join(','))
        .join('|');

    const frame = identity.framePosition
        ? `${identity.framePosition.offsetX},${identity.framePosition.offsetY}`
        : '';

    const src = [
        clipKey,
        identity.targetRatio ?? '',
        frame,
        overlaysFingerprint(identity.imageOverlays),
        audioKey,
    ].join('\u001e');

    // Same cheap stable hash as overlaysFingerprint — this only has to detect DIFFERENCE, and it is
    // only ever compared against a value this function produced.
    let h = 0;
    for (let i = 0; i < src.length; i++) { h = (Math.imul(31, h) + src.charCodeAt(i)) | 0; }
    return `v1:${(h >>> 0).toString(36)}`;
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

/**
 * The render job's snapshot: the frame metadata, plus WHY the render exists.
 *
 * `forceVideo` marks a render whose point is the container, not the burn-in. An autonomous YouTube
 * Short is a brand card — a still, with its words already drawn into the image — and YouTube has no
 * image post, so the still must become an mp4 even though there is nothing to overlay onto it. The
 * worker's "no overlays, nothing to do" bail-out is correct for every other caller and fatal for
 * this one, so the reason has to travel with the job rather than be re-derived from the post.
 */
export interface RenderJobInput extends FrameMeta {
    forceVideo?: boolean;
    /** The ratio this job renders at — the master, or this platform's re-frame of it. */
    targetRatio?: string;
    /**
     * What this job's output will look like (renderFingerprint). Recorded so a sibling that wants
     * the identical file can wait for this job instead of starting a second, and so the worker can
     * re-check before handing its output to anyone else.
     */
    fingerprint?: string;
}

/** True when this job must produce a video even with nothing to burn in. Defensive: old rows have no flag. */
export function readForceVideo(raw: unknown): boolean {
    return !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>).forceVideo === true);
}

/** A job's stored fingerprint, or null on a row written before this field existed. */
export function readFingerprint(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = (raw as Record<string, unknown>).fingerprint;
    return typeof v === 'string' && v ? v : null;
}

/** A job's stored target ratio, or null. */
export function readTargetRatio(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const v = (raw as Record<string, unknown>).targetRatio;
    return typeof v === 'string' && v ? v : null;
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
