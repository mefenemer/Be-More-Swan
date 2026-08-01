// src/utils/format-router.ts
// Derive a post's FORMAT from its media, instead of asking someone to pick one.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// Choosing a format is the one genuinely combinatorial decision in the composer: six platforms,
// each with two or three live formats, none of them the same. Asking for it up front makes the user
// do the mental arithmetic of what every platform's API accepts — and they cannot, because the
// answer depends on the asset they just attached.
//
// The asset already knows. A 9:16 clip under three minutes IS a YouTube Short; the same clip is an
// Instagram Reel; at four minutes it is a YouTube Video instead. Kind, aspect ratio and duration
// determine the format, so the format should be derived and STATED, never asked for.
//
// ── Rules of the house ──────────────────────────────────────────────────────────────────────────
// 1. POST_FORMATS is the only source of truth. No cheat-sheet of platform limits lives here — a
//    second copy of platform rules is exactly the drift that platform-formats.ts and the client
//    constants generator exist to prevent.
// 2. Never route to something unpublishable. Only availability:'live' formats are candidates; a
//    router that can pick a format approval will refuse is worse than no router.
// 3. Unknown is not zero. Legacy assets have NULL dimensions and duration. Where a metric is
//    missing the check is SKIPPED and `verified` says so — a missing duration must never be read as
//    "short enough", or a 40-minute film becomes a Short.
// 4. Nothing is ever silently re-cut. Where an asset needs a crop or a trim the router says so and
//    returns the format it WOULD fit; performing it is the user's call, not ours.

import { inArray } from 'drizzle-orm';
import { contentAssets } from '../../db/schema';
import {
    POST_FORMATS, formatsForPlatform, defaultFormatFor,
    type PostFormatSpec,
} from '../config/post-formats';

/** What we know about one attached asset. Every metric is optional: legacy rows have none. */
export interface AssetMetrics {
    kind: 'image' | 'video';
    width?: number | null;
    height?: number | null;
    durationS?: number | null;
}

export type RouteState =
    | 'ok'      // publishes as-is
    | 'crop'    // right kind, wrong shape — offer a crop
    | 'trim'    // right shape, too long, and no other format takes it
    | 'none';   // this platform has no live format for this media at all

export interface RouteResult {
    state: RouteState;
    /** The format to use, or the nearest one. Null only when nothing on this platform can take it. */
    format: PostFormatSpec | null;
    /** Written for the user, not for a log. Present whenever state is not 'ok'. */
    reason?: string;
    /** True when every check that applies could actually be run against real metrics. */
    verified: boolean;
    /** The platform's other live formats that accept this media, for a manual override. */
    alternatives: PostFormatSpec[];
    /**
     * True when the format was DECLARED by the user rather than derived here.
     *
     * The UI needs the difference: a derived format is a report ("this will go out as a Reel"), a
     * declared one is the user's instruction, and a problem with it is a conflict they have to
     * settle rather than a fact to state.
     */
    declared?: boolean;
    /** Where a declared format cannot take this media, the live format on the same platform that can. */
    suggestion?: PostFormatSpec | null;
}

/** Aspect ratios are quoted as 'w:h' strings; assets arrive as pixels. */
function ratioOf(a: AssetMetrics): number | null {
    if (!a.width || !a.height) return null;
    return a.width / a.height;
}

function parseRatio(s: string): number | null {
    const [w, h] = s.split(':').map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && h > 0 ? w / h : null;
}

// Real assets are never exactly 0.8. A 1082x1350 export is 4:5 by any sane reading, and a 3% band
// covers encoder rounding and the odd off-by-a-pixel crop without letting 1:1 pass as 4:5
// (0.8 vs 1.0 is 25% apart, so there is no risk of collision between the ratios in use).
const RATIO_TOLERANCE = 0.03;

function ratioAccepted(fmt: PostFormatSpec, assetRatio: number | null): boolean {
    if (!fmt.aspectRatios.length) return true;      // format has no ratio opinion
    if (assetRatio == null) return true;            // unknown: skipped, and flagged via `verified`
    return fmt.aspectRatios.some(r => {
        const target = parseRatio(r);
        return target != null && Math.abs(assetRatio - target) / target <= RATIO_TOLERANCE;
    });
}

/** Does this format carry this kind of media at all? */
function carries(fmt: PostFormatSpec, kind: 'image' | 'video'): boolean {
    return fmt.media === 'mixed' || fmt.media === kind;
}

function withinCount(fmt: PostFormatSpec, n: number): boolean {
    return n >= fmt.minItems && n <= fmt.maxItems;
}

/** Over its ceiling? Null when the format sets none, or the asset's length is unknown. */
function overDuration(fmt: PostFormatSpec, a: AssetMetrics): boolean | null {
    if (fmt.maxDurationS == null) return null;
    if (a.durationS == null) return null;
    return a.durationS > fmt.maxDurationS;
}

const secs = (s: number) => (s % 60 === 0 ? `${s / 60} minutes` : `${Math.floor(s / 60)}m ${s % 60}s`);

/**
 * Check a DECLARED format against what is attached.
 *
 * This is the other half of the router, and the reason routeAsset no longer decides everything: once
 * a user has said "this is a Reel", deriving a format from the media would silently overrule them.
 * So where a format is declared the job inverts — the format is fixed and the MEDIA is what is in
 * question.
 *
 * The three ways a declaration can be wrong, and why each answers the way it does:
 *   • wrong KIND or COUNT ('none')  a still cannot become a Reel by cropping. The destination cannot
 *                                   publish as it stands, which is exactly what 'none' means.
 *   • wrong SHAPE ('crop')          unchanged from derivation: the platform crops, it publishes.
 *   • too LONG ('trim')             the one real behaviour change. Derivation REROUTES a 4-minute
 *                                   9:16 clip from Short to Video, which is right when nobody chose
 *                                   — and wrong the moment somebody did. It now reports the conflict
 *                                   and names the format that would take it, for the user to accept.
 */
function checkDeclared(platform: string, declared: PostFormatSpec, assets: AssetMetrics[]): RouteResult {
    const live = formatsForPlatform(platform).filter(f => f.availability === 'live');
    const base = { format: declared, verified: true, alternatives: live, declared: true } as const;

    // Nothing attached yet. Not a fault: the Media step states what the format needs, and saying
    // "no format" over an empty post reads as a broken destination rather than an unstarted one.
    if (!assets.length) return { ...base, state: 'ok' };

    const kinds = new Set(assets.map(a => a.kind));
    const soleKind = kinds.size === 1 ? [...kinds][0] : null;
    const carriesIt = soleKind ? carries(declared, soleKind) : declared.media === 'mixed';

    /** A live format on this platform that WOULD take this media, for the way out of a conflict. */
    const wayOut = (test: (f: PostFormatSpec) => boolean) =>
        live.find(f => f.key !== declared.key && test(f)) ?? null;

    if (!carriesIt) {
        const what = soleKind ?? 'mixed';
        const suggestion = wayOut(f => withinCount(f, assets.length) && (soleKind ? carries(f, soleKind) : f.media === 'mixed'));
        return {
            ...base, state: 'none', suggestion,
            reason: `${declared.label} takes ${declared.media}, and this is ${what}.`
                + (suggestion ? ` ${suggestion.label} would take it.` : ''),
        };
    }

    if (!withinCount(declared, assets.length)) {
        const suggestion = wayOut(f => withinCount(f, assets.length) && (soleKind ? carries(f, soleKind) : f.media === 'mixed'));
        const bounds = declared.minItems === declared.maxItems
            ? `${declared.minItems}`
            : `${declared.minItems}–${declared.maxItems}`;
        return {
            ...base, state: 'none', suggestion,
            reason: `${declared.label} takes ${bounds} item${declared.maxItems === 1 ? '' : 's'}, and this has ${assets.length}.`
                + (suggestion ? ` ${suggestion.label} would take it.` : ''),
        };
    }

    const lead = assets[0];
    const assetRatio = ratioOf(lead);
    const verified = assetRatio != null;

    if (overDuration(declared, lead)) {
        const suggestion = wayOut(f => carries(f, 'video') && overDuration(f, lead) !== true);
        return {
            ...base, verified, state: 'trim', suggestion,
            reason: `${declared.label} takes up to ${secs(declared.maxDurationS!)}, and this is ${secs(Math.round(lead.durationS!))}.`
                + (suggestion ? ` It can go out as a ${suggestion.label} instead.` : ''),
        };
    }

    if (!ratioAccepted(declared, assetRatio)) {
        return {
            ...base, verified, state: 'crop',
            reason: `${declared.label} is ${declared.aspectRatios.join(' or ')}. This asset is a different shape.`,
        };
    }

    return { ...base, verified, state: 'ok' };
}

/**
 * Pick the format a platform should publish these assets as — or check the one it was given.
 *
 * `assets` is the whole attachment list in slide order, because the count is part of the answer:
 * five images is a carousel, one is a feed post. An empty list routes to the platform's default,
 * which is correct for text-first platforms and is what flags the ones that cannot publish
 * text alone.
 *
 * `declaredKey` is the post's own `format_key` where it has one. Passing it switches this from
 * deciding to checking (see checkDeclared). A key that names an unknown format, or one belonging to
 * a different platform, is IGNORED rather than refused — a stale row must still route somewhere, and
 * the strictness belongs at the endpoints that write the column.
 */
export function routeAsset(platform: string, assets: AssetMetrics[], declaredKey?: string | null): RouteResult {
    if (declaredKey) {
        const declared = POST_FORMATS.find(f => f.key === declaredKey);
        if (declared && declared.platform === (platform === 'twitter' ? 'x' : platform)) {
            return checkDeclared(platform, declared, assets);
        }
    }
    return deriveFormat(platform, assets);
}

function deriveFormat(platform: string, assets: AssetMetrics[]): RouteResult {
    const live = formatsForPlatform(platform).filter(f => f.availability === 'live');
    const none = (reason: string): RouteResult =>
        ({ state: 'none', format: null, reason, verified: true, alternatives: [] });

    if (!live.length) return none('This platform has no format we can publish to yet.');

    // No media: only formats that do not demand it.
    if (!assets.length) {
        const textOk = live.filter(f => !f.mediaMandatory && withinCount(f, 0));
        if (!textOk.length) {
            const label = live[0].platform;
            return none(`${label} cannot publish without media.`);
        }
        return { state: 'ok', format: defaultFormatFor(platform) ?? textOk[0], verified: true, alternatives: textOk };
    }

    // A mixed set is only ever a 'mixed' format; otherwise every asset must be the same kind.
    const kinds = new Set(assets.map(a => a.kind));
    const soleKind = kinds.size === 1 ? [...kinds][0] : null;

    const candidates = live.filter(f =>
        withinCount(f, assets.length) &&
        (soleKind ? carries(f, soleKind) : f.media === 'mixed'));

    if (!candidates.length) {
        const what = soleKind ?? 'mixed';
        const anyKind = live.some(f => soleKind && carries(f, soleKind));
        return none(anyKind
            ? `No live format here takes ${assets.length} item${assets.length === 1 ? '' : 's'}.`
            : `No live ${what} format for this platform.`);
    }

    // Ratio is judged on the FIRST asset: on every platform that supports a set, the opening item
    // fixes the shape and the rest are cropped to match it.
    const lead = assets[0];
    const assetRatio = ratioOf(lead);
    const verified = assetRatio != null;

    const fits = candidates.filter(f => ratioAccepted(f, assetRatio));

    if (fits.length) {
        // Prefer the format whose FIRST listed ratio is the asset's — that is its native shape,
        // and it is why a 9:16 clip becomes a Reel rather than merely an accepted video.
        const native = (assetRatio != null
            && fits.find(f => {
                const first = f.aspectRatios[0] != null ? parseRatio(f.aspectRatios[0]) : null;
                return first != null && Math.abs(assetRatio - first) / first <= RATIO_TOLERANCE;
            })) || fits[0];

        if (overDuration(native, lead)) {
            // Length decides between two formats on the same platform. Prefer rerouting over
            // complaining: a 4-minute 9:16 clip is not a broken Short, it is a Video.
            //
            // Searched over CANDIDATES, not `fits` — deliberately. aspectRatios cannot currently
            // say whether a ratio is required or merely preferred, and for the long-form formats it
            // is the latter: YouTube publishes a vertical Video quite happily, it just prefers 16:9.
            // Restricting the fallback to ratio-matching formats left a 4-minute vertical clip with
            // nowhere to go and reported a trim the user did not need to make.
            const longer = candidates.find(f => f.key !== native.key && overDuration(f, lead) !== true);
            if (longer) {
                const shapeNote = ratioAccepted(longer, assetRatio)
                    ? ''
                    : ` ${longer.aspectRatios[0]} is the shape it prefers.`;
                return {
                    state: 'ok', format: longer, verified,
                    reason: `Too long for a ${native.label} (${secs(native.maxDurationS!)}), so it goes out as a ${longer.label}.${shapeNote}`,
                    alternatives: candidates,
                };
            }
            return {
                state: 'trim', format: native, verified,
                reason: `${native.label} takes up to ${secs(native.maxDurationS!)}. This is longer.`,
                alternatives: fits,
            };
        }
        return { state: 'ok', format: native, verified, alternatives: fits };
    }

    // Right kind and count, wrong shape. Offer the nearest, and name the shape it wants.
    const near = candidates[0];
    return {
        state: 'crop', format: near, verified,
        reason: `${near.label} takes ${near.aspectRatios.join(' or ')}. This asset is a different shape.`,
        alternatives: candidates,
    };
}

/**
 * Route one asset set across several platforms at once — what the composer's destination bar shows.
 * Returns a map keyed by platform so a caller can render a tab per entry without re-deriving.
 */
export function routeAcross(platforms: string[], assets: AssetMetrics[]): Record<string, RouteResult> {
    const out: Record<string, RouteResult> = {};
    for (const p of platforms) out[p] = routeAsset(p, assets);
    return out;
}

/** True when a route means "this destination cannot publish as it stands". */
export const routeBlocks = (r: RouteResult): boolean => r.state === 'none';

/**
 * Every platform that cannot publish this asset set as it stands, with the reason.
 *
 * The point of surfacing these together is that the old platform-first flow never did: you chose a
 * platform, then found out. Here it is answerable before anything is scheduled.
 */
export function unroutable(platforms: string[], assets: AssetMetrics[]): Array<{ platform: string; reason: string }> {
    return platforms
        .map(p => ({ platform: p, result: routeAsset(p, assets) }))
        .filter(r => r.result.state === 'none')
        .map(r => ({ platform: r.platform, reason: r.result.reason ?? 'Cannot publish here.' }));
}

/** Formats that declare a duration ceiling, for tests and for anything auditing the catalogue. */
export const FORMATS_WITH_DURATION_LIMIT = POST_FORMATS.filter(f => f.maxDurationS != null);

/**
 * Load what we know about a post's attachments, in slide order.
 *
 * Order matters: the FIRST asset fixes the shape on every platform that publishes a set, so a
 * reordered list would route the post differently. The database returns rows in whatever order it
 * likes, so they are re-sorted back onto the id list the post actually carries.
 *
 * Missing metrics come back as undefined rather than 0 — the router treats that as "not checked",
 * and a 0 would be a lie that passes every ceiling.
 */
export async function loadAssetMetrics(db: any, contentAssetIds: unknown): Promise<AssetMetrics[]> {
    const ids = assetIdList(contentAssetIds);
    if (!ids.length) return [];
    return orderMetrics(ids, await loadAssetMetricsById(db, ids));
}

/** The routable asset ids on a post, in slide order. */
export function assetIdList(contentAssetIds: unknown): number[] {
    return Array.isArray(contentAssetIds) ? contentAssetIds.map(Number).filter(Number.isFinite) : [];
}

/**
 * Metrics for a set of asset ids, keyed by id, in ONE query.
 *
 * Exists so a caller routing several posts at once — the cross-post tab strip asks what EACH
 * platform's own row would publish as — can do it without a query per sibling.
 */
export async function loadAssetMetricsById(db: any, ids: number[]): Promise<Map<number, AssetMetrics>> {
    const out = new Map<number, AssetMetrics>();
    const wanted = [...new Set(ids.filter(Number.isFinite))];
    if (!wanted.length) return out;

    const rows = await db.select({
        id: contentAssets.id,
        assetType: contentAssets.assetType,
        width: contentAssets.width,
        height: contentAssets.height,
        durationS: contentAssets.durationS,
    }).from(contentAssets).where(inArray(contentAssets.id, wanted));

    for (const r of rows as any[]) {
        // 'link' and 'audio' rows are not routable media. Treating them as images would let them
        // satisfy an image format they can never fill.
        if (r.assetType !== 'image' && r.assetType !== 'video') continue;
        out.set(r.id, {
            kind: r.assetType === 'video' ? 'video' : 'image',
            width: r.width ?? undefined,
            height: r.height ?? undefined,
            durationS: r.durationS ?? undefined,
        });
    }
    return out;
}

/** Re-sort loaded metrics back onto the id order the post carries, dropping unroutable rows. */
export function orderMetrics(ids: number[], byId: Map<number, AssetMetrics>): AssetMetrics[] {
    const out: AssetMetrics[] = [];
    for (const id of ids) {
        const m = byId.get(id);
        if (m) out.push(m);
    }
    return out;
}

export interface FormatViolation {
    code: 'VIDEO_TOO_LONG';
    /** Written for the user. */
    reason: string;
    /** The format on this platform that WOULD take it, when one exists. */
    suggestion: PostFormatSpec | null;
}

/**
 * Check a post's CHOSEN format against what is actually attached, for the approval gate.
 *
 * Deliberately narrow. approve-post already refuses unschedulable formats, item counts outside the
 * format's bounds, video on a driver that cannot send it, and Instagram without media — so none of
 * that is repeated here. What it has never been able to check is LENGTH, because until duration was
 * stored there was nothing to check against.
 *
 * Length is the one that ends in a rejected upload rather than an ugly post: YouTube refuses a
 * Short over three minutes outright. Aspect ratio is deliberately NOT enforced — platforms crop,
 * and refusing an approval over a shape the network would happily letterbox would block work that
 * publishes fine.
 *
 * Returns null when there is nothing to say, INCLUDING when the duration is unknown. A legacy asset
 * must never be refused for failing a check that was never run.
 */
export function validateAgainstFormat(
    formatKey: string | null | undefined,
    assets: AssetMetrics[],
): FormatViolation | null {
    const fmt = POST_FORMATS.find(f => f.key === formatKey);
    if (!fmt || fmt.maxDurationS == null) return null;

    const tooLong = assets.find(a => a.durationS != null && a.durationS > fmt.maxDurationS!);
    if (!tooLong) return null;

    // Somewhere else on the same platform that would take it — the message is far more use when it
    // names the way out rather than only the wall.
    const suggestion = formatsForPlatform(fmt.platform)
        .find(f => f.availability === 'live' && f.key !== fmt.key
            && carries(f, 'video') && (f.maxDurationS == null || tooLong.durationS! <= f.maxDurationS)) ?? null;

    return {
        code: 'VIDEO_TOO_LONG',
        reason: `${fmt.label} takes up to ${secs(fmt.maxDurationS)} — this video is ${secs(Math.round(tooLong.durationS!))}.`
            + (suggestion ? ` Switch the format to ${suggestion.label} and it will publish.` : ''),
        suggestion,
    };
}
