// src/utils/post-destinations.ts
// A post's DESTINATIONS: where it goes and what it goes out AS.
//
// ── Why a platform is no longer enough ──────────────────────────────────────────────────────────
// "Instagram" is not a destination. A Reel, a feed post and a carousel are three different things
// with different media, different shapes and different API calls, and a user who wants a Reel and
// nothing else could not say so: every surface keyed a cross-post group by PLATFORM, so a post had
// at most one Instagram row and its format was whatever the router derived from the media.
//
// A destination is therefore a (platform, formatKey) pair, and `formatKey` may be null — meaning
// "whatever this platform's media routes to", which is what every row created before this existed
// carries and what Autopilot still creates. Null is a real, supported answer, not a missing value.
//
// ── The one rule that matters ───────────────────────────────────────────────────────────────────
// Two destinations are the SAME destination when their keys match. Everything else — which rows to
// create, which to delete, which tab you are looking at — follows from that, so the key lives here
// and is never re-derived. Keying by platform alone is precisely the bug this replaces.

import { postFormatSpec } from '../config/post-formats';
import { SOCIAL_PLATFORMS } from '../config/platform-formats';

export interface Destination {
    platform: string;
    /** A POST_FORMATS key, or null for "derive it from the media" (legacy and autonomous rows). */
    formatKey: string | null;
}

/** X is stored as both 'x' and 'twitter'; the catalogue only knows 'x'. */
export const canonicalPlatform = (p: string): string => (p === 'twitter' ? 'x' : p);

/**
 * The identity of a destination. Two rows are the same destination when these match.
 *
 * The platform is canonicalised so a legacy 'twitter' row and an 'x' request are one destination
 * rather than two — otherwise changing the format on an old X post would delete it and make a new one.
 */
export function destinationKey(d: Destination): string {
    return `${canonicalPlatform(d.platform)}|${d.formatKey ?? ''}`;
}

export interface ParseResult {
    destinations: Destination[];
    /** Written for the user; present only when the request cannot be honoured. */
    error?: string;
}

/**
 * Read destinations off a request body, accepting both shapes.
 *
 * `destinations: [{platform, formatKey}]` is what the composer sends now. `platforms: ['instagram']`
 * is the older shape and still arrives from callers that have no opinion about format — it is NOT
 * deprecated-and-broken, it means "these platforms, formats derived", which stays a legitimate
 * request and is exactly what Autopilot wants.
 *
 * `existingFormatFor` matters for the legacy shape only: when a caller names a platform whose row
 * already declares a format, that format is KEPT. Without it, a legacy `platforms` request against a
 * group whose Instagram row is a declared Reel would read as "a different destination" and quietly
 * delete the Reel to make a format-less replacement.
 */
export function parseDestinations(
    body: { destinations?: unknown; platforms?: unknown },
    existingFormatFor?: (platform: string) => string | null | undefined,
): ParseResult {
    const raw: Destination[] = [];

    if (Array.isArray(body.destinations)) {
        for (const d of body.destinations) {
            if (!d || typeof d !== 'object') continue;
            const platform = String((d as any).platform ?? '');
            const formatKeyRaw = (d as any).formatKey;
            if (!platform) continue;
            raw.push({ platform, formatKey: formatKeyRaw ? String(formatKeyRaw) : null });
        }
    } else if (Array.isArray(body.platforms)) {
        for (const p of body.platforms) {
            if (typeof p !== 'string' || !p) continue;
            raw.push({ platform: p, formatKey: existingFormatFor?.(p) ?? null });
        }
    }

    if (!raw.length) return { destinations: [], error: 'Pick at least one destination.' };

    const unknownPlatform = raw.find(d => !(SOCIAL_PLATFORMS as string[]).includes(canonicalPlatform(d.platform)));
    if (unknownPlatform) return { destinations: [], error: `Unsupported platform: ${unknownPlatform.platform}.` };

    // The format must belong to the platform it is paired with. Availability is deliberately NOT
    // checked: save-post-format.ts already lets an unpublishable format be SAVED so a user can plan a
    // carousel before we can send one, and approve-post is the gate that stops it reaching the queue.
    // Two endpoints disagreeing about that would make the same format legal to set and illegal to
    // create with.
    for (const d of raw) {
        if (!d.formatKey) continue;
        const spec = postFormatSpec(d.formatKey);
        if (!spec) return { destinations: [], error: `Unknown post format: ${d.formatKey}.` };
        if (spec.platform !== canonicalPlatform(d.platform)) {
            return { destinations: [], error: `“${spec.label}” is a ${spec.platform} format — it cannot go out on ${d.platform}.` };
        }
    }

    // Dedupe on the key, keeping first-seen order: the order destinations arrive in is the order the
    // composer shows its tabs, and reordering them silently would move the tab under the cursor.
    const seen = new Set<string>();
    const destinations: Destination[] = [];
    for (const d of raw) {
        const k = destinationKey(d);
        if (seen.has(k)) continue;
        seen.add(k);
        destinations.push(d);
    }

    return { destinations };
}

/**
 * The legacy `post_format` column for a destination — 'text' | 'image' | 'video'.
 *
 * Still written because publish-social-posts and several readers depend on it. Derived from the
 * declared format where there is one, so a Reel row says 'video' rather than the 'image' that
 * create-manual-post used to guess from "did the user attach anything".
 */
export function legacyPostFormat(d: Destination, hasMedia: boolean): string {
    const spec = d.formatKey ? postFormatSpec(d.formatKey) : null;
    if (spec) {
        if (spec.media === 'video') return 'video';
        if (spec.media === 'image' || spec.media === 'mixed') return hasMedia ? 'image' : 'text';
        return 'text';
    }
    return hasMedia ? 'image' : 'text';
}
