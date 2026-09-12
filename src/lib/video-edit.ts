// src/lib/video-edit.ts
//
// The edit list: what the user did to their footage before any platform was involved.
//
// ── Why this is one column and not the junction table ───────────────────────────────────────────
// The obvious home for "the clips in this post, in order" is scheduled_post_assets — it already has
// a position column. It cannot be, because attachRenderedVideo() (post-render.ts) DELETES every
// junction row for the post and inserts the rendered file at position 0. That is correct while a
// post has one source clip and one rendered output; the moment the junction table IS the edit, the
// first successful render destroys the edit that produced it, and re-opening the post shows one
// clip where there were four. So the junction table keeps meaning "what publishes", and this column
// means "what the user assembled". They are different questions and they now have different homes.
//
// ── One model, several phases ───────────────────────────────────────────────────────────────────
// The shape here is the finished one — an ordered clip list, a target frame, per-platform framing —
// so that no phase needs a second migration. What each phase HONOURS is smaller:
//
//   Phase 1 ✅: clips[0] only, with its in/out points. Trim on a single clip.
//   Phase 2 ✅: the whole array, rendered as a <Series>; targetRatio becomes the output frame.
//   Phase 3 ✅: `gain` per clip, and the mute-when-music-is-present default.
//   Phase 4 ✅: `frames`, the per-platform crop offsets.
//
// Writing the full shape now costs nothing and stops the sanitiser being rewritten four times.
// Anything not yet honoured is stored faithfully and ignored by the renderer.
//
// Times are seconds against the SOURCE clip, half-open [inS, outS) — the same convention as text
// overlays (overlay-geometry.ts) and audio (audio-overlays.ts). An absent bound means "the clip's
// own edge", which is why a trim of nothing is representable and harmless.

/** One source clip on the timeline. */
export interface VideoClip {
    id: string;
    /** content_assets.id of the source video. The bytes live in R2. */
    assetId: number;
    /** Seconds into the source where this segment starts. Absent = from the clip's own start. */
    inS?: number;
    /** Seconds into the source where it ends. Absent = to the clip's own end. */
    outS?: number;
    /**
     * 0..1 on the clip's OWN audio. Phase 3 — stored now so the model does not change later, and
     * deliberately absent rather than defaulted to 1: "the user has not decided" and "the user chose
     * full volume" want to be distinguishable when the mute-under-music default lands.
     */
    gain?: number;
}

/** Per-platform framing of the master. Phase 4. */
export interface VideoFrame {
    /** -1..1, fraction of the overflow. 0 is centred, which is the default everywhere. */
    offsetX: number;
    offsetY: number;
}

export interface VideoEdit {
    clips: VideoClip[];
    /** 'w:h' of the master. Phase 2 makes this the output frame; until then the source decides. */
    targetRatio?: string;
    /** Keyed by platform. Phase 4. */
    frames?: Record<string, VideoFrame>;
}

/**
 * A reel of twenty segments is already an unusual post; past that the render cost stops being
 * bounded by anything the reviewer can see. Rejecting the payload (rather than truncating it) keeps
 * the failure in front of the person who can fix it.
 */
export const MAX_CLIPS = 20;

/** The master frame when nothing says otherwise. Vertical serves four of six platforms as-is. */
export const DEFAULT_TARGET_RATIO = '9:16';

/**
 * Hard ceiling on a rendered timeline, in seconds.
 *
 * Mirrors MAX_RENDER_SECONDS in post-render.ts, deliberately duplicated rather than imported: that
 * module pulls in the database client, and importing it from here would drag drizzle and a Neon
 * connection into the Remotion bundle that runs inside Lambda's headless Chrome. This file is pure
 * on purpose — it is the one piece of the model both sides share.
 */
export const MAX_TIMELINE_SECONDS = 600;

const RATIO_RE = /^\d{1,2}:\d{1,2}$/;

/** 'w:h' → the two numbers, or null when it is not a ratio we can use. */
export function parseRatio(s: string | null | undefined): { w: number; h: number } | null {
    if (!s || !RATIO_RE.test(s)) return null;
    const [w, h] = s.split(':').map(Number);
    return w > 0 && h > 0 ? { w, h } : null;
}

/** h264 chroma subsampling needs even dimensions; an odd one fails the encode at the very end. */
const evenPx = (n: number) => { const r = Math.round(n); return r % 2 === 0 ? r : r + 1; };

/**
 * The output frame for a target ratio.
 *
 * This exists because a multi-clip edit has no "source" to inherit a frame from — the whole point of
 * phase 2 is that four clips of four different shapes produce one video, so the frame has to be
 * stated rather than measured. (A single-clip post still measures its source: an untouched clip
 * should render at exactly the size it already is, not be resampled to our idea of vertical.)
 *
 * The rule is "short side 1080, long side capped at 1920", which lands on the sizes every platform
 * actually documents — 1080×1920 for 9:16, 1080×1080 for 1:1, 1080×1350 for 4:5, 1920×1080 for 16:9
 * — without a lookup table that would drift from POST_FORMATS.
 */
export function frameForRatio(ratio: string | null | undefined): { width: number; height: number } | null {
    const r = parseRatio(ratio);
    if (!r) return null;
    const scale = 1080 / Math.min(r.w, r.h);
    let width = r.w * scale;
    let height = r.h * scale;
    const longest = Math.max(width, height);
    if (longest > 1920) {
        const shrink = 1920 / longest;
        width *= shrink;
        height *= shrink;
    }
    return { width: evenPx(width), height: evenPx(height) };
}

/** A non-negative finite number, or undefined. Mirrors the `time()` helper in the audio model. */
function time(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Normalise whatever the client sent.
 *
 * Permissive but bounded, exactly like sanitiseAudioOverlays: the editor owns the shape, this only
 * stops malformed or unbounded data reaching the DB and, later, a billed render. Returns null when
 * the payload is not a usable edit — the caller answers 422 rather than storing junk.
 *
 * A clip with no asset is dropped rather than rejected: the editor can hold an empty row while the
 * user is still choosing, and refusing the whole save at that moment would lose the other clips.
 */
export function sanitiseVideoEdit(raw: unknown): VideoEdit | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const e = raw as Record<string, unknown>;
    if (!Array.isArray(e.clips)) return null;
    if (e.clips.length > MAX_CLIPS) return null;

    const clips: VideoClip[] = [];
    for (const item of e.clips) {
        if (!item || typeof item !== 'object') return null;
        const c = item as Record<string, unknown>;
        const assetId = Number(c.assetId);
        if (!Number.isInteger(assetId) || assetId <= 0) continue;

        const inS = time(c.inS);
        let outS = time(c.outS);
        // A zero-length or inverted window degrades to "to the end of the clip" rather than a
        // segment that renders nothing — the same rule text and audio already use for their bounds.
        // Getting this wrong produces a zero-frame composition, which is a hard Remotion error at
        // the end of a billed render rather than a visible mistake in the editor.
        if (inS != null && outS != null && outS <= inS) outS = undefined;

        clips.push({
            id: typeof c.id === 'string' ? c.id.slice(0, 64) : `c${assetId}_${clips.length}`,
            assetId,
            ...(inS != null ? { inS } : {}),
            ...(outS != null ? { outS } : {}),
            ...(c.gain == null ? {} : { gain: clamp(Number(c.gain) || 0, 0, 1) }),
        });
    }

    const targetRatio = typeof e.targetRatio === 'string' && RATIO_RE.test(e.targetRatio)
        ? e.targetRatio
        : undefined;

    let frames: Record<string, VideoFrame> | undefined;
    if (e.frames && typeof e.frames === 'object' && !Array.isArray(e.frames)) {
        frames = {};
        for (const [platform, v] of Object.entries(e.frames as Record<string, unknown>)) {
            if (!v || typeof v !== 'object') continue;
            const f = v as Record<string, unknown>;
            frames[platform.slice(0, 32)] = {
                offsetX: clamp(Number(f.offsetX) || 0, -1, 1),
                offsetY: clamp(Number(f.offsetY) || 0, -1, 1),
            };
        }
        if (!Object.keys(frames).length) frames = undefined;
    }

    return {
        clips,
        ...(targetRatio ? { targetRatio } : {}),
        ...(frames ? { frames } : {}),
    };
}

/** Clips with something to play. Mirrors renderableAudio()/renderableOverlays(). */
export function renderableClips(raw: unknown): VideoClip[] {
    const edit = readVideoEdit(raw);
    return edit ? edit.clips.filter(c => Number.isInteger(c.assetId) && c.assetId > 0) : [];
}

/** Read a stored jsonb value back as an edit, tolerating the null/legacy-shape cases. */
export function readVideoEdit(raw: unknown): VideoEdit | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const e = raw as Partial<VideoEdit>;
    if (!Array.isArray(e.clips)) return null;
    return { clips: e.clips as VideoClip[], targetRatio: e.targetRatio, frames: e.frames };
}

/**
 * Does this clip actually cut anything?
 *
 * `inS: 0` with no `outS` is a clip the user opened and left alone, and it must NOT count — a post
 * whose only "edit" is an untouched trim would be gated behind a render that changes nothing,
 * burning a Lambda slot and delaying the publish for no visible difference.
 */
export function clipIsTrimmed(clip: VideoClip): boolean {
    return (clip.inS != null && clip.inS > 0) || clip.outS != null;
}

/** Any real cut anywhere in the edit. */
export function editHasTrim(raw: unknown): boolean {
    return renderableClips(raw).some(clipIsTrimmed);
}

/**
 * Does this edit produce a file that differs from the post's raw media? The question the render gate
 * actually asks.
 *
 * Two ways to answer yes, and the second is what phase 2 added: a cut anywhere, OR more than one
 * clip. Stitching changes the file even when every clip is played whole, so an untrimmed four-clip
 * reel still has to render — gating only on `editHasTrim` would have let it publish as clip one,
 * alone, with no error anywhere.
 */
export function editChangesMedia(raw: unknown): boolean {
    const clips = renderableClips(raw);
    return clips.length > 1 || clips.some(clipIsTrimmed);
}

/**
 * How loud this clip's OWN audio should be — the camera's sound, not anything added on the timeline.
 *
 * The rule: an explicit gain always wins, and otherwise the presence of a track on the timeline
 * mutes the footage. Four clips of club noise fighting a music bed is the failure this default
 * exists to prevent, and it is the reason `gain` is left ABSENT by the sanitiser rather than
 * defaulted to 1 — "the user has not decided" and "the user chose full volume" have to be different
 * answers or this default could never fire.
 *
 * ⚠️ Only ever call this for clips that came from a real edit. A post that has never been edited —
 * an ordinary video with a voice note over it — must keep playing its own audio exactly as it does
 * today. Applying the default there would silently re-mix every existing post the next time it
 * rendered, which is a change nobody asked for and nobody would be told about.
 */
export function resolveClipGain(clip: VideoClip, hasTimelineAudio: boolean): number | undefined {
    if (clip.gain != null) return clamp(clip.gain, 0, 1);
    return hasTimelineAudio ? 0 : undefined;
}

/**
 * The trim to apply to the rendered clip, resolved against the source's real length.
 *
 * `sourceDurationS` is what the renderer measured, and it wins over anything stored: content_assets
 * holds no duration column, so every number that reaches here came off a <video> element in a
 * browser and can be stale, absent, or from a different asset entirely. An out point past the end
 * of the file is clamped rather than refused — the clip simply runs to its end, which is what the
 * user saw in the editor.
 *
 * Returns null when the trim is a no-op, so callers can skip the props entirely.
 */
export function resolveTrim(
    clip: VideoClip,
    sourceDurationS: number | null | undefined,
): { inS: number; outS: number | null; durationS: number | null } | null {
    if (!clipIsTrimmed(clip)) return null;

    const known = typeof sourceDurationS === 'number' && Number.isFinite(sourceDurationS) && sourceDurationS > 0
        ? sourceDurationS
        : null;

    const inS = known != null ? clamp(clip.inS ?? 0, 0, known) : (clip.inS ?? 0);
    let outS = clip.outS ?? null;
    if (outS != null && known != null) outS = clamp(outS, 0, known);

    // Clamping can collapse the window (an in point past the end of a shorter-than-expected file).
    // Falling back to the whole clip is the safe direction: a clip that plays in full is a visible
    // mistake the reviewer can fix, where a zero-length composition is a failed render.
    if (outS != null && outS <= inS) return { inS: 0, outS: null, durationS: known };

    const durationS = outS != null ? outS - inS : (known != null ? known - inS : null);
    return { inS, outS, durationS };
}
