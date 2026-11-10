// src/lib/loudness.ts
//
// Even loudness for Video Producer renders: every finished video aims at about −14 LUFS, the level
// Instagram, TikTok, YouTube and Facebook normalise to, so a video is neither turned down hard by the
// platform nor quieter than the one before it in the feed.
//
// ── How, without measuring the render ───────────────────────────────────────────────────────────
// Nothing on the server can decode audio (no ffmpeg on a function), and the render happens on Remotion
// Lambda. So the mix is LEVELLED FROM MEASUREMENTS MADE BEFOREHAND, track by track:
//   · each voiceover voice  — measured from its /audio/voices/<id>.mp3 sample (same provider, same
//                             voice), src/config/media-loudness.json `voices`
//   · each library track    — measured from the pack file, keyed by its storage key, `music`
//   · the owner's footage   — estimated from the loudness the browser sent with the footage review
//                             (RMS every 0.1 s, src/lib/footage.ts), over the stretches with sound in them
// and each track gets a gain that brings it to the target. The foreground (the voice, or the footage's
// own sound) is aimed at the target; a music bed sits under it (MUSIC_UNDER_DB below the foreground
// while someone speaks, MUSIC_GAP_DB between sentences). With no foreground the music IS the
// foreground and is aimed at the target itself.
//
// It is an aim, not a guarantee: a voice sample is not the script, and footage loudness is estimated
// from RMS. The measurements put every input within a dB or two of the target, which is the spread
// platforms already tolerate. All gains are capped (MAX_GAIN) so a near-silent input is never pumped
// into noise.
//
// PURE: no database, no network. Tested in tests/video-producer-seven.test.ts.

import table from '../config/media-loudness.json';

export const TARGET_LUFS = -14;
/** What an unmeasured input is assumed to be — the middle of what the voices and tracks measured. */
export const ASSUMED_LUFS = -16;
/** +12 dB at most: past that a quiet recording is mostly its own noise floor. */
export const MAX_GAIN = 4;
/** A music bed under speech, and between sentences, relative to the foreground (dB). */
export const MUSIC_UNDER_DB = -18;
export const MUSIC_GAP_DB = -9;

const VOICES = (table as { voices?: Record<string, number> }).voices ?? {};
const MUSIC = (table as { music?: Record<string, number> }).music ?? {};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Linear gain for a change in dB. Pure. */
export function dbToGain(db: number): number {
    return Math.pow(10, db / 20);
}

/** The gain that takes an input measured at `lufs` to `target`, capped to [0, MAX_GAIN]. Pure. */
export function gainToTarget(lufs: number | null | undefined, target = TARGET_LUFS): number {
    const from = finite(lufs) ? lufs : ASSUMED_LUFS;
    return round3(Math.min(MAX_GAIN, Math.max(0, dbToGain(target - from))));
}

/** Measured loudness of a voiceover voice, or null when that voice was never measured. Pure. */
export function voiceLufs(voiceId: string | null | undefined): number | null {
    const v = voiceId ? VOICES[voiceId] : undefined;
    return finite(v) ? v : null;
}

/** Measured loudness of a library track by its storage key, or null. Pure. */
export function musicLufs(storageKey: string | null | undefined): number | null {
    const v = storageKey ? MUSIC[storageKey] : undefined;
    return finite(v) ? v : null;
}

/**
 * Estimated loudness of the owner's footage from the browser's RMS samples (RMS × 1000, every 0.1 s).
 * Only the stretches with sound count (above a tenth of the loudest), as a loudness meter's gate
 * ignores silence; the upper-middle of those (the 70th percentile) stands for the speech. RMS dBFS
 * reads close to LUFS for speech. Null with no usable samples. Pure.
 */
export function footageLufs(loudness: number[] | null | undefined): number | null {
    if (!Array.isArray(loudness) || !loudness.length) return null;
    const vals = loudness.filter((x) => finite(x) && x > 0);
    if (!vals.length) return null;
    const max = Math.max(...vals);
    const gated = vals.filter((x) => x >= max * 0.1).sort((a, b) => a - b);
    const p = gated[Math.min(gated.length - 1, Math.floor(gated.length * 0.7))];
    const rms = p / 1000;
    if (!(rms > 0)) return null;
    return Math.round(20 * Math.log10(Math.min(1, rms)) * 10) / 10;
}

/** The mix for one video: a gain per part. Pure. */
export interface MixLevels {
    /** On the voiceover track (may exceed 1 — rendered as extra gain). */
    voice: number;
    /** On the owner's own clips in their own sound — capped at 1, the clip gain's ceiling. */
    ownSound: number;
    /** On the music bed between sentences (or throughout, with nothing spoken). */
    music: number;
    /** On the music bed while someone speaks. */
    musicUnder: number;
}

/**
 * Work out the mix. `voice` / `footage` / `music` are each input's measured loudness (null = not
 * measured, undefined = not in this video). Pure.
 */
export function mixLevels(args: { voice?: number | null; footage?: number | null; music?: number | null; hasVoice: boolean; hasOwnSound: boolean; hasMusic: boolean }): MixLevels {
    const voice = args.hasVoice ? gainToTarget(args.voice) : 0;
    const ownSound = args.hasOwnSound ? Math.min(1, gainToTarget(args.footage)) : 0;
    let music = 0, musicUnder = 0;
    if (args.hasMusic) {
        const foreground = args.hasVoice || args.hasOwnSound;
        if (!foreground) {
            music = musicUnder = gainToTarget(args.music);
        } else {
            // The bed is set against where the foreground actually lands — own footage that cannot be
            // raised to the target (gain capped at 1) gets a quieter bed, so the speech still leads.
            const fgLufs = args.hasVoice ? TARGET_LUFS : landedLufs(args.footage, ownSound);
            music = gainToTarget(args.music, fgLufs + MUSIC_GAP_DB);
            musicUnder = gainToTarget(args.music, fgLufs + MUSIC_UNDER_DB);
        }
    }
    return { voice, ownSound: round3(ownSound), music, musicUnder };
}

/** Where an input measured at `lufs` lands after `gain`. Pure. */
export function landedLufs(lufs: number | null | undefined, gain: number): number {
    const from = finite(lufs) ? lufs : ASSUMED_LUFS;
    return Math.round((from + 20 * Math.log10(Math.max(1e-4, gain))) * 10) / 10;
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }
