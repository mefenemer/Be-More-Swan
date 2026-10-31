// src/lib/storyboard.ts
//
// The Video Producer's storyboard (docs/video-producer-plan.md §5.2–5.3): a brief becomes a list of
// scenes, each with a beat, a voiceover line, optional on-screen text and a visual source.
//
// The model WRITES the storyboard; this module DECIDES whether it is usable. Every rule the plan
// lists is enforced here in code, not trusted to the prompt:
//   · 3–8 scenes; the first is a hook of ≤ 3 s, the last carries the call to action
//   · total length within ±10 % of what was asked (rescaled, hook re-capped)
//   · stock-first: AI sources only where the brief allows them, AI clips capped per video
//   · a "product photo" scene must name one of the workspace's OWN pictures — an AI picture of
//     someone's product invents the product, so an unknown id becomes stock, never AI
//   · no URLs read aloud or painted on screen (models invent them)
//
// PURE: no database, no network. Tested in tests/storyboard.test.ts.

import { isStillMotion, type StillMotion } from './still-motion';

export const SCENE_SOURCES = ['stock_video', 'stock_photo', 'ai_video', 'ai_image', 'brand_card', 'product_photo'] as const;
export type SceneSource = typeof SCENE_SOURCES[number];
export const BEATS = ['hook', 'problem', 'value', 'proof', 'cta'] as const;
export type Beat = typeof BEATS[number];

export const VIDEO_LENGTHS = [15, 30, 60] as const;
export type VideoLength = typeof VIDEO_LENGTHS[number];
export type AiAllowance = 'stock_only' | 'stock_and_ai' | 'ai_first';

export const MIN_SCENES = 3;
export const MAX_SCENES = 8;
export const MAX_HOOK_S = 3;
export const MIN_SCENE_S = 1.5;
/** AI clips per video (owner decision D4, 2026-10-31). */
export const MAX_AI_CLIPS = 3;
/** Natural speaking pace the planner writes to — the same figure the voiceover panel shows. */
export const WORDS_PER_SECOND = 2.5;

export interface VideoBrief {
    purpose: string;            // 'promo' | 'product spotlight' | 'offer' | 'tip' | free text
    lengthS: VideoLength;
    message: string;            // what the video must say
    cta?: string | null;        // the call to action, binding when given
    voiceover: boolean;
    voice?: string | null;
    allowAi: AiAllowance;
    musicMood?: string | null;
}

export interface Scene {
    id: string;
    beat: Beat;
    voiceover: string;
    onScreenText?: string;
    source: SceneSource;
    /** For AI sources: what to picture (no words in it). */
    prompt?: string;
    /** For stock: 2–4 search words. */
    keywords?: string;
    /** For product_photo: one of the workspace's own library pictures. */
    assetId?: number;
    /** Movement on a still scene. */
    motion?: StillMotion;
    targetS: number;
}

export interface Storyboard {
    title: string;
    caption: string;
    scenes: Scene[];
}

/** A picture the planner may use for a product_photo scene. */
export interface LibraryPicture { id: number; name: string }

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const clip = (s: unknown, n: number) => String(typeof s === 'string' ? s : '').replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, n);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function isVideoLength(v: unknown): v is VideoLength {
    return (VIDEO_LENGTHS as readonly number[]).includes(Number(v));
}

/** Is this a still (picture) scene? Stills get a hold time and a movement; clips get trimmed. */
export function isStillSource(source: SceneSource): boolean {
    return source === 'stock_photo' || source === 'ai_image' || source === 'brand_card' || source === 'product_photo';
}

/** What a disallowed AI source falls back to. Pure. */
function stockFor(source: SceneSource): SceneSource {
    if (source === 'ai_video') return 'stock_video';
    if (source === 'ai_image') return 'stock_photo';
    return source;
}

/**
 * Make a model's storyboard safe to build. Pure; never throws. Returns the storyboard and the
 * changes made, so the review panel can say what was adjusted rather than silently differ.
 */
export function enforceStoryboard(raw: unknown, brief: VideoBrief, library: LibraryPicture[] = []): { storyboard: Storyboard; changes: string[] } {
    const changes: string[] = [];
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const libraryIds = new Set(library.map((p) => p.id));
    const motions: StillMotion[] = ['push_in', 'pan_right', 'pull_out', 'pan_left'];

    let scenes: Scene[] = (Array.isArray(r.scenes) ? r.scenes : []).slice(0, MAX_SCENES).map((s, i) => {
        const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        let source: SceneSource = (SCENE_SOURCES as readonly string[]).includes(String(o.source)) ? o.source as SceneSource : 'stock_video';
        const assetId = Number(o.assetId);
        if (source === 'product_photo' && !libraryIds.has(assetId)) {
            source = 'stock_photo';
            changes.push(`Scene ${i + 1}: that picture isn't in your library, so a stock photo is used instead.`);
        }
        const beat: Beat = (BEATS as readonly string[]).includes(String(o.beat)) ? o.beat as Beat : 'value';
        const scene: Scene = {
            id: `s${i + 1}`,
            beat,
            voiceover: clip(o.voiceover, 240),
            source,
            targetS: Math.max(MIN_SCENE_S, Number(o.targetS) || brief.lengthS / 5),
        };
        const text = clip(o.onScreenText, 60);
        if (text) scene.onScreenText = text;
        const prompt = clip(o.prompt, 600);
        if (prompt) scene.prompt = prompt;
        const keywords = clip(o.keywords, 60);
        if (keywords) scene.keywords = keywords;
        if (source === 'product_photo') scene.assetId = assetId;
        if (isStillSource(source)) scene.motion = isStillMotion(o.motion) && o.motion !== 'none' ? o.motion : motions[i % motions.length];
        return scene;
    });

    // Too few scenes is not repairable by rules — the caller re-plans or falls back.
    if (scenes.length < MIN_SCENES) {
        changes.push(`The plan had ${scenes.length} scene${scenes.length === 1 ? '' : 's'}; a video needs at least ${MIN_SCENES}.`);
    }

    // AI allowance, then the per-video clip cap. Earliest AI clips are kept (the hook matters most).
    if (brief.allowAi === 'stock_only') {
        for (const s of scenes) {
            if (s.source === 'ai_video' || s.source === 'ai_image') {
                s.source = stockFor(s.source);
                if (!s.keywords) s.keywords = clip(s.prompt, 60).split(' ').slice(0, 4).join(' ');
            }
        }
    }
    let aiClips = 0;
    for (const s of scenes) {
        if (s.source !== 'ai_video') continue;
        aiClips++;
        if (aiClips > MAX_AI_CLIPS) {
            s.source = 'stock_video';
            if (!s.keywords) s.keywords = clip(s.prompt, 60).split(' ').slice(0, 4).join(' ');
            changes.push(`At most ${MAX_AI_CLIPS} AI clips per video — scene ${scenes.indexOf(s) + 1} uses stock footage.`);
        }
    }
    // Stills keep a movement; a still turned into stock video no longer needs one.
    for (const s of scenes) {
        if (!isStillSource(s.source)) delete s.motion;
        else if (!s.motion) s.motion = 'push_in';
    }

    // Beats: hook first, call to action last.
    if (scenes.length) {
        if (scenes[0].beat !== 'hook') { scenes[0].beat = 'hook'; changes.push('The first scene is now the hook.'); }
        const last = scenes[scenes.length - 1];
        if (scenes.length > 1 && last.beat !== 'cta') { last.beat = 'cta'; changes.push('The last scene is now the call to action.'); }
        if (brief.cta && scenes.length > 1 && !last.voiceover.toLowerCase().includes(brief.cta.toLowerCase().slice(0, 20))) {
            last.onScreenText = clip(brief.cta, 60);
        }
    }

    scenes = fitLength(scenes, brief.lengthS, changes);

    return {
        storyboard: {
            title: clip(r.title, 80) || clip(brief.message, 60) || 'New video',
            caption: clip(r.caption, 600),
            scenes,
        },
        changes,
    };
}

/** Rescale scene lengths to the asked-for total (±10 %), keeping the hook ≤ 3 s. Pure. */
export function fitLength(scenes: Scene[], lengthS: number, changes: string[] = []): Scene[] {
    if (!scenes.length) return scenes;
    const total = scenes.reduce((a, s) => a + s.targetS, 0);
    const lo = lengthS * 0.9, hi = lengthS * 1.1;
    let out = scenes.map((s) => ({ ...s }));
    if (total < lo || total > hi) {
        const k = lengthS / total;
        out = out.map((s) => ({ ...s, targetS: Math.max(MIN_SCENE_S, s.targetS * k) }));
        changes.push(`Scene lengths adjusted to make a ${lengthS}-second video.`);
    }
    if (out[0].targetS > MAX_HOOK_S) {
        const spare = out[0].targetS - MAX_HOOK_S;
        out[0].targetS = MAX_HOOK_S;
        if (out.length > 1) {
            const share = spare / (out.length - 1);
            for (let i = 1; i < out.length; i++) out[i].targetS += share;
        }
    }
    return out.map((s) => ({ ...s, targetS: round1(s.targetS) }));
}

/** The whole voiceover, scene by scene, as one script (one voiceover track per video). Pure. */
export function scriptOf(storyboard: Storyboard): string {
    return storyboard.scenes.map((s) => s.voiceover).filter(Boolean).join(' ');
}

/**
 * Split one voiceover's word timings back into scenes: scene i is heard from its first word to the
 * next scene's first word. Each scene's length is its speech plus a short breath, never less than its
 * planned minimum — the voice sets the cut, the plan only fills silence. Pure.
 *
 * Words are matched by COUNT (scene i owns its share of the spoken words), because the transcription
 * is of the audio, not the script: punctuation and numbers come back spelt differently.
 */
export function sceneTimingsFromWords(
    storyboard: Storyboard,
    words: Array<{ start: number; end: number }>,
): number[] | null {
    const counts = storyboard.scenes.map((s) => (s.voiceover ? s.voiceover.split(/\s+/).filter(Boolean).length : 0));
    const planned = counts.reduce((a, b) => a + b, 0);
    if (!planned || !words.length) return null;
    // Scale planned counts to the number of words actually heard.
    const k = words.length / planned;
    const starts: number[] = [];
    let idx = 0;
    for (let i = 0; i < counts.length; i++) {
        starts.push(idx < words.length ? words[Math.min(idx, words.length - 1)].start : words[words.length - 1].end);
        idx += Math.round(counts[i] * k);
    }
    const end = words[words.length - 1].end + 0.4;
    return storyboard.scenes.map((s, i) => {
        const from = i === 0 ? 0 : starts[i];
        const to = i + 1 < starts.length ? starts[i + 1] : end;
        const spoken = Math.max(0, to - from);
        return round1(Math.max(spoken, counts[i] ? MIN_SCENE_S : s.targetS));
    });
}

/** Credits a storyboard will cost before anything is made (shown on the button). Pure. */
export function estimateCredits(storyboard: Storyboard, brief: VideoBrief, costs: { image: number; video: number; voiceover: number }): number {
    let n = 0;
    for (const s of storyboard.scenes) {
        if (s.source === 'ai_image') n += costs.image;
        if (s.source === 'ai_video') n += costs.video;
    }
    if (brief.voiceover && scriptOf(storyboard)) n += costs.voiceover;
    return n;
}

// ── The planner prompt ──────────────────────────────────────────────────────────────────────────

export function storyboardSystemPrompt(): string {
    return `You are a short-form video producer for a small business. You plan vertical (9:16) promo videos for Instagram Reels, YouTube Shorts and Facebook.

Rules:
- One idea per video. Open with a hook that lands in under 3 seconds. End with the call to action.
- Write the voiceover to be SPOKEN: short sentences, about ${WORDS_PER_SECOND} words per second of scene. No URLs, no hashtags, no emoji.
- On-screen text is optional and short (under 8 words). The voiceover is captioned automatically, so do not repeat it on screen.
- Visual sources, in order of preference: stock_video, stock_photo, product_photo (ONLY with an id from the library list), brand_card (a branded text card — good for the call to action), ai_image, ai_video.
- AI prompts describe a scene with NO words, letters, logos or signs in it. Never use AI to picture the business's own product — use product_photo or stock.
- Stock keywords are 2–4 plain words a stock library would match.
- Use only facts from the business information given. Never invent prices, offers, awards or claims.

Return STRICT JSON only:
{"title": "...", "caption": "a post caption, 1–3 sentences", "scenes": [{"beat": "hook|problem|value|proof|cta", "voiceover": "...", "onScreenText": "...", "source": "stock_video|stock_photo|product_photo|brand_card|ai_image|ai_video", "keywords": "...", "prompt": "...", "assetId": 123, "motion": "push_in|pull_out|pan_left|pan_right", "targetS": 4}]}`;
}

export function storyboardUserPrompt(args: {
    brief: VideoBrief;
    businessName: string;
    businessFacts: string;
    library: LibraryPicture[];
    today: string;
    feedback?: string | null;
}): string {
    const { brief } = args;
    const allow = brief.allowAi === 'stock_only' ? 'Do NOT use ai_image or ai_video.'
        : brief.allowAi === 'ai_first' ? `AI sources are welcome (at most ${MAX_AI_CLIPS} ai_video scenes).`
        : `Prefer stock; AI is allowed where stock would not fit (at most ${MAX_AI_CLIPS} ai_video scenes).`;
    return [
        `Today is ${args.today}.`,
        `BUSINESS: ${args.businessName}`,
        args.businessFacts ? `BUSINESS INFORMATION:\n${args.businessFacts}` : '',
        `VIDEO: a ${brief.lengthS}-second ${clip(brief.purpose, 60) || 'promo'} video, ${MIN_SCENES}–${MAX_SCENES} scenes, scene lengths adding up to ${brief.lengthS} seconds.`,
        `WHAT IT MUST SAY: ${clip(brief.message, 600)}`,
        brief.cta ? `CALL TO ACTION (use these words in the last scene): ${clip(brief.cta, 200)}` : '',
        brief.voiceover ? 'It has a voiceover — every scene needs a voiceover line.' : 'No voiceover — leave voiceover empty and use onScreenText to carry the message.',
        allow,
        args.library.length
            ? `LIBRARY PICTURES you may use as product_photo (id: name):\n${args.library.slice(0, 30).map((p) => `${p.id}: ${clip(p.name, 80)}`).join('\n')}`
            : 'There are no library pictures — do not use product_photo.',
        args.feedback ? `THE OWNER'S NOTES ON THE LAST VERSION (follow them): ${clip(args.feedback, 600)}` : '',
    ].filter(Boolean).join('\n\n');
}

/** Pull the JSON object out of a model reply. Pure; null when there is none. */
export function parseStoryboardJson(text: string): unknown | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
