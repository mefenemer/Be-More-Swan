// src/lib/presenters.ts
//
// The AI presenters (docs/video-producer-screen-walkthrough-plan.md §11, Phase A1). The list is
// src/public/presenter-catalogue.json — the same file the picker (src/components/presenter-picker.js) reads,
// so a presenter offered there is always one the server knows. Each has a face (the picture the avatar model
// is given), a thumbnail and a 5-second sample for the picker, and its own English voice; in any other
// language a presenter speaks with the catalogue voice of their gender, so one face speaks every language the
// voice list has (§11.4). PURE apart from the JSON import. Tested in tests/presenters.test.ts.

import CATALOGUE from '../public/presenter-catalogue.json';
import VOICES from '../public/voice-catalogue.json';

export type PresenterGender = 'female' | 'male';
export interface Presenter {
    id: string;
    name: string;
    gender: PresenterGender;
    age: string;
    /** A short description, for alt text and the chat. */
    look: string;
    /** Their own voice per language (voice-catalogue ids). Only English is set; others follow gender. */
    voices: Record<string, string>;
}

interface CatalogueVoice { id: string; lang: string; gender: string; legacy?: boolean }

export const PRESENTERS: readonly Presenter[] = (CATALOGUE as { presenters: Presenter[] }).presenters;
/** The avatar model the samples were made with (and the default for the real thing, decision D-A1). */
export const PRESENTER_MODEL: string = (CATALOGUE as { model: string }).model;

export function presenterById(id: unknown): Presenter | null {
    return PRESENTERS.find((p) => p.id === id) ?? null;
}

/** Where a presenter's files are served (static, made once by scripts/make-presenters.mjs). */
export function presenterFiles(id: string): { face: string; thumb: string; sample: string } {
    const safe = encodeURIComponent(id);
    return { face: `/presenters/${safe}.jpg`, thumb: `/presenters/${safe}-thumb.jpg`, sample: `/presenters/${safe}.mp4` };
}

const offered = (): CatalogueVoice[] => (VOICES as { voices: CatalogueVoice[] }).voices.filter((v) => !v.legacy);

/**
 * The voice a presenter speaks `lang` with: their own voice for that language when it's an offered voice of
 * that language, else the first offered voice of that language and their gender, else null (a language the
 * voice list doesn't have). Pure.
 */
export function presenterVoice(p: Presenter, lang: string, voices: CatalogueVoice[] = offered()): string | null {
    const own = p.voices[lang];
    if (own && voices.some((v) => v.id === own && v.lang === lang)) return own;
    return voices.find((v) => v.lang === lang && v.gender === p.gender)?.id ?? null;
}

/** The languages a presenter can speak today: every language with an offered voice of their gender. Pure. */
export function presenterLanguages(p: Presenter, voices: CatalogueVoice[] = offered()): string[] {
    return [...new Set(voices.filter((v) => v.gender === p.gender || v.id === p.voices[v.lang]).map((v) => v.lang))];
}

// ── A2: presenter scenes (§11.1–11.6) ────────────────────────────────────────────────────────────

/**
 * The feature flag (feature_flags.key). Off everywhere until the Terms 30-day notice for the per-second price
 * has run (D-A3); a workspace on the flag's allowed list sees it early (staging tests).
 */
export const AI_PRESENTER_FLAG = 'ai_presenter';

/**
 * The brief as this workspace may have it: without the presenter unless the ai_presenter flag is on. Applied to the
 * brief that is SAVED (video-projects create → startProject), never only to a copy (review of #721). Pure.
 */
export function briefForWorkspace<T>(raw: T, presenterAllowed: boolean): T {
    if (presenterAllowed || !raw || typeof raw !== 'object' || Array.isArray(raw) || !('presenter' in (raw as object))) return raw;
    const { presenter: _dropped, ...rest } = raw as Record<string, unknown>;
    return rest as T;
}

/** Without "Show me throughout", the presenter is in at most this many scenes: the opening, the call to action and one key moment (D-A7). */
export const PRESENTER_KEY_SCENES = 3;

/** A video's presenter, as the brief carries it. */
export interface BriefPresenter { id: string; throughout?: boolean }

/** A brief's presenter made safe: a catalogue presenter, else null. Pure. */
export function readBriefPresenter(raw: unknown): BriefPresenter | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const p = presenterById(o.id);
    if (!p) return null;
    return { id: p.id, ...(o.throughout === true ? { throughout: true } : {}) };
}

/** Tasks for a presenter on screen for `seconds` (D-A3: per second, rounded up). Pure. */
export function presenterTasks(seconds: number, perSecond: number): number {
    return Math.max(1, Math.ceil(Math.max(0, seconds))) * Math.max(0, perSecond);
}

/** The face picture for a video's shape, as kept in storage (uploaded once by scripts/make-presenters.mjs). Pure. */
export function presenterFaceKey(id: string, shape: string | null | undefined): string {
    const s = shape === '9:16' ? '9x16' : shape === '1:1' ? '1x1' : '16x9';
    return `presenters/${encodeURIComponent(id)}-${s}.jpg`;
}

/**
 * The stretch of the voiceover a presenter scene lip-syncs: the scene's window plus a short tail (clamped to the
 * voice), so the clip the model returns always covers the scene and is trimmed to it. Pure.
 */
export const PRESENTER_AUDIO_TAIL_S = 0.3;
export function presenterAudioWindow(startS: number, endS: number, voiceS: number): { startS: number; endS: number } {
    const a = Math.max(0, Math.min(startS, voiceS));
    const b = Math.max(a, Math.min(endS + PRESENTER_AUDIO_TAIL_S, voiceS));
    return { startS: Math.round(a * 1000) / 1000, endS: Math.round(b * 1000) / 1000 };
}

/**
 * Pieces of a presenter's stretch of speech (Phase 4c-2). Kling took 12 min 26 s for a 37.6 s clip, so a long
 * scene is made as several short clips side by side, played back to back. Pieces aim for PRESENTER_PIECE_S and
 * never pass PRESENTER_MAX_PIECE_S. Each cut falls in the widest pause between words near its aim (the lips are
 * still there), else at the longest a piece may be. Times are on the video's clock. Pure.
 */
export const PRESENTER_PIECE_S = 15;
export const PRESENTER_MAX_PIECE_S = 20;
export function presenterPieces(startS: number, endS: number, words: Array<{ start: number; end: number }> = []): Array<{ startS: number; endS: number }> {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    if (!(endS - startS > PRESENTER_MAX_PIECE_S)) return [{ startS: r(startS), endS: r(endS) }];
    // The gaps between words inside the stretch, as candidate cut points (their middles).
    const ws = words.filter((w) => w.end > startS && w.start < endS).slice().sort((a, b) => a.start - b.start);
    const gaps: Array<{ at: number; width: number }> = [];
    for (let i = 1; i < ws.length; i++) {
        const width = ws[i].start - ws[i - 1].end;
        if (width > 0.04) gaps.push({ at: (ws[i - 1].end + ws[i].start) / 2, width });
    }
    const out: Array<{ startS: number; endS: number }> = [];
    let from = startS;
    while (endS - from > PRESENTER_MAX_PIECE_S) {
        const lo = from + PRESENTER_PIECE_S * 0.6, hi = from + PRESENTER_MAX_PIECE_S;
        // The widest pause in reach; ties go to the one nearest the aim.
        const aim = from + PRESENTER_PIECE_S;
        const pick = gaps.filter((g) => g.at > lo && g.at < hi && endS - g.at >= 1)
            .sort((a, b) => (b.width - a.width) || (Math.abs(a.at - aim) - Math.abs(b.at - aim)))[0];
        const cut = pick ? pick.at : Math.min(hi, endS - 1);
        out.push({ startS: r(from), endS: r(cut) });
        from = cut;
    }
    out.push({ startS: r(from), endS: r(endS) });
    return out;
}

/**
 * Why a brief's screen recordings can't be used (A3), or null when they can: the owner's permission tick, every one
 * the workspace's own upload (`owned` = what an ownership query of those ids returned), and every one measured (a
 * screen is laid out by its length). Status and message for the create response. Pure (review of #725).
 */
export function screenRefusal(screenIds: number[], consent: boolean, owned: Array<{ id: number; durationS: number | null }>): { status: number; error: string } | null {
    if (!screenIds.length) return null;
    if (!consent) return { status: 400, error: 'Tick “I have permission to use the people and music in these videos” first.' };
    const mine = new Map(owned.map((v) => [v.id, v]));
    if (screenIds.some((id) => !mine.has(id))) return { status: 404, error: 'One of those screen recordings isn’t one of your own uploads.' };
    if (screenIds.some((id) => !(Number(mine.get(id)!.durationS) > 0))) return { status: 409, error: 'One of those screen recordings has no length yet. Upload it again, or use it once with “Use my own footage”, then choose it.' };
    return null;
}
