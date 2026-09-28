// src/lib/music-library.ts
//
// The curated music library — tracks we have licensed ourselves, hosted on our own storage.
//
// ── Why a library and not a stock API ───────────────────────────────────────────────────────────
// Every other media source in this product is a third party's search endpoint (see src/utils/pexels.ts).
// Music is deliberately not, and the reason is whose risk it is. A customer publishes a post
// commercially; if the music under it turns out to be licensed for non-commercial use only, or the
// provider changes its terms, or a track is withdrawn, the exposure lands on them and on us — not on
// the API we borrowed it from. A library we licensed once, hold the paperwork for, and host
// ourselves can be answered for. Breadth is the price, and it is worth paying.
//
// It also removes three failure modes the stock path lives with: rate limits, a CDN that must stay
// reachable at render time, and terms-of-service rules about hotlinking. Remotion Lambda fetches the
// file from our own storage exactly as it does for an uploaded voice note.
//
// ── What this module is ─────────────────────────────────────────────────────────────────────────
// Pure. No database, no fetch. The library's ROWS live in `music_tracks`; the RULES about what may
// be offered and what must be credited live here, so they can be tested without a renderer, a
// network or a seeded table — the same reasoning that put audioGainAt in audio-overlays.ts after
// fades sat unread in the database for a month.

/**
 * What we are permitted to do with one track, in the vendor's own words.
 *
 * ⚠️ `attributionRequired` is not a preference and must never be wired to one. Pexels attribution is
 * a courtesy we offer per organisation (`creditLine` in src/utils/pexels.ts, opt-in). A music licence
 * that DEMANDS a credit is a condition of use: an organisation that turns credits off must simply not
 * be offered those tracks, because publishing one without its credit is a breach committed on the
 * customer's account. Two different things that look identical in a settings panel, which is exactly
 * how they get conflated.
 */
export interface TrackLicence {
    /** The licence as the vendor names it, e.g. 'Standard Commercial (perpetual)'. Stored verbatim. */
    name: string;
    /** Where the terms live. For the record we keep, not for the UI. */
    termsUrl?: string;
    /** Must a credit appear wherever a post using this track is published? */
    attributionRequired: boolean;
    /** The exact wording the licence demands. Meaningless to paraphrase — it is a legal string. */
    attributionText?: string;
    /**
     * When our right to offer this track ends, ISO date, absent meaning perpetual.
     *
     * ⚠️ An expiry stops us OFFERING the track. It does not retract posts already published with it —
     * they were licensed when they went out, and rewriting history would be both wrong and
     * impossible. See usableTracks().
     */
    expiresAt?: string;
}

export interface MusicTrack {
    id: number;
    title: string;
    artist: string;
    /** Our own storage. Never a third party's CDN — that is the whole point of the library. */
    url: string;
    /**
     * Length in seconds, STORED rather than measured.
     *
     * ⚠️ Deliberately unlike a clip, whose duration is measured in the browser because Pexels does
     * not supply one — and which therefore vanishes from the editor whenever the measurement fails
     * (see _pceTrimAxis). We control ingestion here, so there is no excuse for not knowing, and the
     * picker can show a length before anything has been downloaded.
     */
    durationS: number;
    /** Mood and genre, lower-case, for the picker's filters. Free-form on purpose; curation is human. */
    tags: string[];
    licence: TrackLicence;
    /** Withdrawn tracks stay in the table so published posts keep resolving. They are not offered. */
    isActive: boolean;
}

/** Longest a bed may be before the picker warns it will be cut. Matches the Reel ceiling. */
export const MAX_TRACK_S = 180;

/**
 * The tracks that may be OFFERED right now.
 *
 * Two reasons to withhold one, and they behave identically to the customer and differently to us: a
 * track we withdrew (`isActive` false) and a licence that has run out. Neither is retroactive — a
 * post published last month keeps its track and its credit, because it was licensed when it went out.
 *
 * `now` is passed rather than read, so a test can stand on either side of an expiry without moving
 * the clock.
 */
export function usableTracks(tracks: MusicTrack[], now: Date): MusicTrack[] {
    const t = now.getTime();
    return tracks.filter((track) => {
        if (!track || !track.isActive) return false;
        if (!track.licence?.expiresAt) return true;
        const ends = Date.parse(track.licence.expiresAt);
        return !Number.isFinite(ends) || ends > t;
    });
}

/**
 * The credits a post MUST carry, given the tracks on it.
 *
 * Returns the exact strings the licences demand, de-duplicated and in a stable order — two clips from
 * the same artist under one licence is one credit, not two. Empty when nothing on the post requires
 * one, which is the common case for a library licensed for commercial use.
 *
 * ⚠️ Required credits only. A track whose licence does not demand attribution is not listed here even
 * if crediting it would be polite: mixing "must" and "nice to" produces a list nobody can safely
 * shorten, and the first thing a user does with a long credit block is delete it.
 */
export function requiredCredits(tracks: MusicTrack[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const track of tracks) {
        const lic = track?.licence;
        if (!lic?.attributionRequired) continue;
        // A licence that requires a credit but supplies no wording is a curation error, and silence
        // is the one response that cannot be right — fall back to the plainest true statement.
        const text = (lic.attributionText || `Music: ${track.title} by ${track.artist}`).trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

/**
 * Can this organisation be offered this track?
 *
 * The one asymmetry worth encoding: an organisation that publishes without credits can use any track
 * whose licence does not demand one, and none that does. It is not a warning and not a checkbox — the
 * track simply is not theirs to use on those terms, so it is not shown.
 */
export function offerableTo(tracks: MusicTrack[], opts: { creditsEnabled: boolean }): MusicTrack[] {
    if (opts.creditsEnabled) return tracks;
    return tracks.filter((t) => !t.licence?.attributionRequired);
}

/**
 * Normalise a row out of `music_tracks` into a track, or null if it is not usable.
 *
 * Returns null rather than a partial track: a bed with no url renders silence, and a bed with no
 * duration cannot be drawn on the timeline — both would reach the editor looking like a track and
 * behave like a fault.
 */
export function toTrack(row: unknown): MusicTrack | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, any>;
    const id = Number(r.id);
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const durationS = Number(r.durationS ?? r.duration_s);
    if (!Number.isInteger(id) || id <= 0 || !url || !(durationS > 0)) return null;

    const rawLic = (r.licence ?? r.license ?? {}) as Record<string, any>;
    return {
        id,
        title: String(r.title || 'Untitled').slice(0, 200),
        artist: String(r.artist || 'Unknown').slice(0, 200),
        url,
        durationS,
        tags: Array.isArray(r.tags) ? r.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean) : [],
        licence: {
            name: String(rawLic.name || 'Unspecified').slice(0, 200),
            termsUrl: typeof rawLic.termsUrl === 'string' ? rawLic.termsUrl : undefined,
            // ⚠️ Defaults to TRUE when absent. An unknown licence is treated as the stricter one:
            // crediting a track that did not need it costs a line of caption, and not crediting one
            // that did is a breach on the customer's account.
            attributionRequired: rawLic.attributionRequired !== false,
            attributionText: typeof rawLic.attributionText === 'string' ? rawLic.attributionText : undefined,
            expiresAt: typeof rawLic.expiresAt === 'string' ? rawLic.expiresAt : undefined,
        },
        isActive: r.isActive !== false && r.is_active !== false,
    };
}
