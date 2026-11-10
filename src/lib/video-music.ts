// src/lib/video-music.ts
//
// Music under a Video Producer video. The brief has always asked for a mood (`musicMood`) and nothing
// ever used it; this is what does. A track comes from the curated royalty-free library (music_tracks,
// 40 CC0 tracks in four moods, identified by storage_key — never a URL), is laid under the whole video
// with a fade in and out, and ducks under the voice: quiet while someone speaks, up a little between
// sentences (src/lib/loudness.ts sets both levels).
//
// The mood is the brief's: 'chill' | 'upbeat' | 'ambient' | 'inspiring', 'auto' (picked from what the
// video is), or 'none' — No music. A brief with no mood at all (every video before 2026-11-10) is 'auto'.
//
// PURE: no database, no network. Tested in tests/video-producer-seven.test.ts.

import type { AudioOverlay } from './audio-overlays';

export const MUSIC_MOODS = ['chill', 'upbeat', 'ambient', 'inspiring'] as const;
export type MusicMood = typeof MUSIC_MOODS[number];
export type MusicChoice = MusicMood | 'auto' | 'none';
export const MUSIC_LABELS: Record<MusicChoice, string> = {
    auto: 'Picked to suit the video', chill: 'Chilled', upbeat: 'Upbeat', ambient: 'Calm, in the background', inspiring: 'Inspiring', none: 'No music',
};

export function isMusicChoice(v: unknown): v is MusicChoice {
    return v === 'auto' || v === 'none' || (MUSIC_MOODS as readonly string[]).includes(String(v));
}

/** A brief's music choice, read leniently: old free-text moods map onto the four, unknown = auto. Pure. */
export function readMusicChoice(v: unknown): MusicChoice {
    if (v === false || v === null) return 'auto';
    const s = String(v ?? '').toLowerCase().trim();
    if (isMusicChoice(s)) return s;
    if (!s) return 'auto';
    if (/\b(no|none|off|silent|without)\b/.test(s)) return 'none';
    if (/upbeat|energ|happy|fun|lively|party|fast/.test(s)) return 'upbeat';
    if (/inspir|uplift|motiv|epic|hope/.test(s)) return 'inspiring';
    if (/ambient|calm|soft|gentle|background|relax/.test(s)) return 'ambient';
    if (/chill|lo-?fi|laid|cosy|cozy|mellow/.test(s)) return 'chill';
    return 'auto';
}

/** The mood an 'auto' video gets, from what kind of video it is. Pure. */
export function moodFor(brief: { musicMood?: string | null; purpose?: string | null; message?: string | null }): MusicMood | null {
    const choice = readMusicChoice(brief.musicMood);
    if (choice === 'none') return null;
    if (choice !== 'auto') return choice;
    const text = `${brief.purpose ?? ''} ${brief.message ?? ''}`.toLowerCase();
    if (/offer|sale|launch|event|new|discount|deal|opening/.test(text)) return 'upbeat';
    if (/tip|how to|explain|guide|learn/.test(text)) return 'chill';
    if (/story|mission|journey|why we|community|charity/.test(text)) return 'inspiring';
    return 'upbeat';
}

/** One library track as the picker needs it. */
export interface LibraryTrack { id: number; title: string; storageKey: string; durationS: number; tags: string[] }

/**
 * Pick a track for a mood: tagged with that mood, long enough to cover the video where possible,
 * and chosen by `seed` (the project id) so the same video keeps the same track and different videos
 * don't all get the first one. `avoid` = a track to skip ("another track"). Pure.
 */
export function pickTrack(tracks: LibraryTrack[], mood: MusicMood, videoS: number, seed: number, avoid?: number | null): LibraryTrack | null {
    const ofMood = tracks.filter((t) => t.tags.map((x) => x.toLowerCase()).includes(mood));
    const pool0 = ofMood.length ? ofMood : tracks;
    const pool1 = pool0.length > 1 && avoid ? pool0.filter((t) => t.id !== avoid) : pool0;
    const long = pool1.filter((t) => t.durationS >= videoS);
    const pool = (long.length ? long : pool1).slice().sort((a, b) => a.id - b.id);
    if (!pool.length) return null;
    return pool[Math.abs(Math.floor(seed)) % pool.length];
}

/**
 * When someone is speaking: the voice's word timings merged into stretches (a gap under `joinS` is
 * the same sentence), each widened by `padS`. Seconds on the video's timeline. Pure.
 */
export function speechWindows(words: Array<{ start: number; end: number }>, joinS = 0.6, padS = 0.15): Array<{ startS: number; endS: number }> {
    const out: Array<{ startS: number; endS: number }> = [];
    for (const w of [...words].filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start).sort((a, b) => a.start - b.start)) {
        const last = out[out.length - 1];
        if (last && w.start - last.endS <= joinS) last.endS = Math.max(last.endS, w.end);
        else out.push({ startS: w.start, endS: w.end });
    }
    return out.map((x) => ({ startS: r2(Math.max(0, x.startS - padS)), endS: r2(x.endS + padS) }));
}

/**
 * The music bed as an audio track: the whole video (bounded — an unbounded track extends the render),
 * a gentle fade in and a longer fade out, `gap` gain between sentences and `under` while `windows`
 * are spoken. An older render bundle that doesn't know `duck` plays it at `volume` throughout. Pure.
 */
export function musicTrack(args: { assetId: number; title: string; durationS: number; gap: number; under: number; windows: Array<{ startS: number; endS: number }> }): AudioOverlay {
    const level = Math.max(0, args.gap);
    // `volume` stays 0..1 (the sanitiser's range); anything above 1 travels as `level`.
    const volume = Math.min(1, level);
    const extra = level > 1 ? level : undefined;
    return {
        id: `vp_music_${args.assetId}`, assetId: args.assetId, label: `Music · ${args.title}`.slice(0, 120),
        startS: 0, endS: r2(Math.max(1, args.durationS)), volume, fadeInS: 0.6, fadeOutS: 1.5,
        ...(extra ? { level: r3(extra) } : {}),
        ...(args.windows.length ? { duck: { volume: r3(level > 0 ? Math.min(1, args.under / level) : 0), windows: args.windows } } : {}),
    };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
