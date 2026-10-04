// src/lib/music-prompt.ts
// What we ask Stable Audio for, built from what the user typed. PURE — no I/O — so the rules below
// are tested directly (tests/ai-music-generation.test.ts) rather than through a paid API call.
//
// Two rules are the reason this file exists, and both are about what the CUSTOMER publishes:
//
//   1. INSTRUMENTAL ONLY. Words are a second set of rights (lyrics) and a second set of risks (a
//      model singing a real lyric it half-remembers). A bed under a social video wants none of it.
//
//   2. NO NAMED ARTIST OR SONG. "In the style of <artist>" is the request most likely to produce
//      something a label would recognise, and it is the one thing the licensed-training story does
//      not cover — imitation is about the OUTPUT, not the training set. Refused with a reason
//      rather than silently stripped, because a quietly-rewritten prompt produces music the user
//      did not ask for and they will simply try again.

export const MUSIC_MOODS = ['upbeat', 'chill', 'ambient', 'inspiring', 'dramatic', 'corporate'] as const;
export type MusicMood = typeof MUSIC_MOODS[number];

export const MUSIC_PACES = ['slow', 'medium', 'fast'] as const;
export type MusicPace = typeof MUSIC_PACES[number];

/** Our bounds, inside Stability's 1–380 s. A Reel is at most 3 minutes; past that the cost and wait
 *  grow for a bed nobody listens to the end of. Under 6 s is not music, it is a sting. */
export const MUSIC_MIN_S = 6;
export const MUSIC_MAX_S = 190;
export const DESCRIPTION_MAX = 400;

const MOOD_WORDS: Record<MusicMood, string> = {
    upbeat: 'upbeat, bright, energetic',
    chill: 'chilled, relaxed, lo-fi',
    ambient: 'ambient, atmospheric, calm',
    inspiring: 'inspiring, uplifting, hopeful',
    dramatic: 'dramatic, cinematic, building tension',
    corporate: 'modern, polished, confident, corporate',
};

const PACE_WORDS: Record<MusicPace, string> = {
    slow: 'slow tempo, around 80 BPM',
    medium: 'medium tempo, around 105 BPM',
    fast: 'fast tempo, around 125 BPM',
};

/**
 * Phrases that ask for an imitation. Deliberately about the PHRASING, not a list of names: there is
 * no list of every artist, and "piano like Ludovico Einaudi" is caught by "like" + a capitalised
 * name just as well as by knowing who he is.
 */
const IMITATION = [
    /\bin the (?:style|vein|manner) of\b/i,
    /\bstyle of\b/i,
    /\b(?:sounds?|sounding)\s+like\b/i,
    /\bsimilar to\b/i,
    /\b(?:a\s+)?(?:cover|remix|rip-?off|copy)\s+of\b/i,
    /\binspired by\b/i,
    /\bsong by\b/i,
    // "like Taylor Swift", "like The Weeknd" — `like` followed by a Capitalised name. Lower-case
    // "like rain on a window" is a description and passes.
    /\blike\s+(?:the\s+)?[A-Z][a-z]+/,
];

/** Asking for words to be sung. The model is told "no vocals" anyway; this says so up front. */
const VOCALS = /\b(?:lyrics?|vocals?|singing|sung|singer|rap(?:ping)?|choir)\b/i;

export type MusicPromptResult =
    | { ok: true; prompt: string; durationS: number }
    | { ok: false; error: string };

export function clampMusicDuration(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 30;
    return Math.round(Math.min(MUSIC_MAX_S, Math.max(MUSIC_MIN_S, n)));
}

export function buildMusicPrompt(input: {
    description?: unknown;
    mood?: unknown;
    pace?: unknown;
    durationS?: unknown;
}): MusicPromptResult {
    const description = String(input.description ?? '').replace(/\s+/g, ' ').trim();
    const mood = MUSIC_MOODS.includes(input.mood as MusicMood) ? (input.mood as MusicMood) : null;
    const pace = MUSIC_PACES.includes(input.pace as MusicPace) ? (input.pace as MusicPace) : null;

    if (!description && !mood) {
        return { ok: false, error: 'Pick a mood or describe the music you want.' };
    }
    if (description.length > DESCRIPTION_MAX) {
        return { ok: false, error: `Keep the description under ${DESCRIPTION_MAX} characters.` };
    }
    if (IMITATION.some((re) => re.test(description))) {
        return {
            ok: false,
            error: 'Describe the sound rather than an artist or song — instruments, mood and tempo work best. '
                + 'Music that imitates a named artist is the one kind we cannot safely make for you to publish.',
        };
    }
    if (VOCALS.test(description)) {
        return { ok: false, error: 'Generated music is instrumental only — there are no vocals or lyrics. Describe the instruments instead.' };
    }

    const parts = [
        description,
        mood ? MOOD_WORDS[mood] : '',
        pace ? PACE_WORDS[pace] : '',
        // Last, so it is the instruction the model reads with nothing after it to override it.
        'instrumental, no vocals, background music for a social media video, clean mix',
    ].filter(Boolean);

    return { ok: true, prompt: parts.join('. '), durationS: clampMusicDuration(input.durationS) };
}

/** "upbeat, bright, energetic. slow tempo…" → a readable name for the asset and the timeline row. */
export function musicLabel(prompt: string): string {
    const first = String(prompt || '').split('.')[0].trim();
    const short = first.length > 40 ? first.slice(0, 40).replace(/\s+\S*$/, '') + '\u2026' : first;
    return `AI music \u2014 ${short || 'generated track'}`;
}

export const TRACK_NAME_MAX = 80;

/**
 * The name a generated track is saved under. The user's own if they gave one (trimmed, control
 * characters out, capped), else the readable default. Never empty: an unnamed row on the timeline is
 * indistinguishable from a broken one.
 */
export function trackName(raw: unknown, prompt: string): string {
    const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TRACK_NAME_MAX).trim();
    return name || musicLabel(prompt);
}

/** The terms clause a shared track is given under, recorded with the customer's consent. */
export const COMMUNITY_TERMS_CLAUSE = '11.8';
export const COMMUNITY_TERMS_URL = 'https://bemoreswan.com/terms_of_service.html#community-music';

/**
 * The public title of a community-shared track.
 *
 * ⚠️ Never the customer's own name for it, and never their description. Both are free text typed for
 * their own post — "Launch of Smith & Co spring sale", "for Dr Patel's clinic opening" — and the
 * library is shown to every other workspace. Mood and pace say what the track IS; the job id keeps
 * two "Upbeat · fast" tracks apart.
 */
export function communityTrackTitle(mood: unknown, pace: unknown, jobId: number): string {
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    const m = MUSIC_MOODS.includes(mood as MusicMood) ? cap(mood as string) : null;
    const p = MUSIC_PACES.includes(pace as MusicPace) ? (pace as string) : null;
    const base = m && p ? `${m} \u00B7 ${p}` : m || (p ? cap(p) : 'AI track');
    return `${base} #${jobId}`;
}

/** Library tags for a shared track — mood and pace only, the same vocabulary the picker filters on. */
export function communityTrackTags(mood: unknown, pace: unknown): string[] {
    const out: string[] = [];
    if (MUSIC_MOODS.includes(mood as MusicMood)) out.push(mood as string);
    if (MUSIC_PACES.includes(pace as MusicPace)) out.push(pace as string);
    out.push('ai-generated', 'community');
    return out;
}
