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
