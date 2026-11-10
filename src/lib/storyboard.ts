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
//   · an "own video" scene must name one of the videos the owner chose, and its segment is clamped
//     to that video's MEASURED length — never the model's numbers (a segment past the end of a file
//     fails the whole render: "No frame found", 2026-11-01)
//
// PURE: no database, no network. Tested in tests/storyboard.test.ts.

import type { CaptionStyle } from './captions';
import { isStillMotion, type StillMotion } from './still-motion';
import { readNameCaption, type LowerThirdStyle, type NameCaption } from './lower-third';
import type { VideoLook } from './video-look';

export const SCENE_SOURCES = ['stock_video', 'stock_photo', 'ai_video', 'ai_image', 'brand_card', 'product_photo', 'own_video'] as const;
export type SceneSource = typeof SCENE_SOURCES[number];
export const BEATS = ['hook', 'problem', 'value', 'proof', 'cta'] as const;
export type Beat = typeof BEATS[number];

export const VIDEO_LENGTHS = [15, 30, 60] as const;

/**
 * The shape of the finished video (owner decision D-S2, 2026-11-09): the Video Producer makes a video
 * for anywhere, so it asks for a shape, never platforms. Vertical for Reels, Shorts and Stories;
 * square for feeds; wide for YouTube and websites.
 */
export const VIDEO_SHAPES = ['9:16', '1:1', '16:9'] as const;
export type VideoShape = typeof VIDEO_SHAPES[number];
export const SHAPE_LABELS: Record<VideoShape, string> = { '9:16': 'vertical (9:16)', '1:1': 'square (1:1)', '16:9': 'wide (16:9)' };
export function isVideoShape(v: unknown): v is VideoShape {
    return (VIDEO_SHAPES as readonly string[]).includes(String(v));
}
/** The frame a shape renders at — even pixels, 1080 on the short side. Pure. */
export function shapeFrame(shape: VideoShape | null | undefined): { width: number; height: number } {
    return shape === '1:1' ? { width: 1080, height: 1080 } : shape === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}
/** Stock search orientation for a shape. Pure. */
export function shapeOrientation(shape: VideoShape | null | undefined): 'portrait' | 'landscape' | 'square' {
    return shape === '1:1' ? 'square' : shape === '16:9' ? 'landscape' : 'portrait';
}
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
    /** With musicMood 'mine': the owner's own audio asset from My Content (src/lib/video-music.ts). */
    musicAssetId?: number | null;
    /** Language the script is written in (voice-catalogue.json code); absent = the voice's own. */
    language?: string | null;
    /** Burn the spoken words in as captions (default on), and how they look (captions.ts). */
    captions?: boolean;
    captionStyle?: CaptionStyle | null;
    /**
     * The owner's own videos this one is made from (docs/video-producer-footage-and-ai-plan.md §4).
     * Absent or empty = an ordinary video from stock, pictures and AI. With footage and no voiceover,
     * the footage keeps its own sound and each own-video scene is exactly its segment.
     */
    footageAssetIds?: number[];
    /** Cut pauses, "um"s and repeated takes out of own footage in its own sound. Absent = on. */
    tighten?: boolean;
    /** The finished video's shape. Absent = vertical 9:16 (every video before 2026-11-09). */
    shape?: VideoShape;
    /** Who it's for, and what they should do after watching (2026-11-10). Fed to the planner. */
    audience?: string | null;
    goal?: string | null;
    /** A colour look over every scene (src/lib/video-look.ts). Absent = natural. */
    look?: VideoLook | null;
    /** How name captions look (src/lib/lower-third.ts). Absent = 'bar'. */
    lowerThird?: LowerThirdStyle | null;
    /** This video is another shape of video N (one click "Make it in the other shapes"). */
    shapeOf?: number | null;
    /** "Another track": the library track the next build must not pick again. */
    avoidTrackId?: number | null;
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
    /** For own_video: the segment of the owner's video (`assetId`), in seconds against the source. */
    inS?: number;
    outS?: number;
    /**
     * For own_video in its own sound: the pieces of the segment that play, once pauses, "um"s and
     * repeated takes are taken out (src/lib/footage.ts tightenSegment). Absent = the whole segment.
     * Worked out by the server from the review's word timings — never taken from the model.
     */
    cuts?: Array<{ inS: number; outS: number }>;
    /** What tightening took out, for the Videos tab ("2 pauses, 1 “um” cut — 3.1 s shorter"). */
    tightened?: { pauses: number; fillers: number; retakes: number; savedS: number };
    /** false = the owner chose "Keep as filmed" for this scene. */
    tighten?: boolean;
    /** Who is on screen, as a lower-third name caption (src/lib/lower-third.ts). */
    nameCaption?: NameCaption;
    targetS: number;
}

export interface Storyboard {
    title: string;
    caption: string;
    scenes: Scene[];
    /**
     * When the owner approved the voiceover script on its own (ISO), before any picture was made
     * ("script first", 2026-11-10). Any later change to a voiceover line clears it.
     */
    scriptApprovedAt?: string | null;
    /** The library track the build chose (src/lib/video-music.ts), kept so a new version keeps it. */
    music?: { trackId: number; title: string; mood: string } | null;
}

/** A picture the planner may use for a product_photo scene. */
export interface LibraryPicture { id: number; name: string }

/** One of the owner's videos the planner may cut own_video scenes from. `durationS` is MEASURED. */
export interface OwnVideo { id: number; name: string; durationS: number }

/**
 * The fewest scenes a usable video has. Three for a made-up video (hook, body, call to action) — but
 * a video from the owner's own footage is often ONE take plus a closing card, and the three-scene
 * rule failed the first real talking-head plan on staging (2026-11-09). Pure.
 */
export function minScenesFor(brief: Pick<VideoBrief, 'footageAssetIds'>): number {
    return brief.footageAssetIds?.length ? 1 : MIN_SCENES;
}

/** A cut shorter than this is a flash, not a scene. */
export const MIN_OWN_SEGMENT_S = 0.8;

/** Does this video keep its footage's own sound? Footage chosen, no voiceover. Pure. */
export function keepsOwnSound(brief: Pick<VideoBrief, 'voiceover' | 'footageAssetIds'>): boolean {
    return !brief.voiceover && !!brief.footageAssetIds?.length;
}

/**
 * A segment of an own video, made safe: inside [0, durationS], in order, at least MIN_OWN_SEGMENT_S.
 * Null when the video is too short to hold one. Pure.
 */
export function clampSegment(inS: unknown, outS: unknown, durationS: number): { inS: number; outS: number } | null {
    if (!(durationS >= MIN_OWN_SEGMENT_S)) return null;
    let a = Number(inS), b = Number(outS);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = durationS;
    if (b < a) [a, b] = [b, a];
    a = Math.min(Math.max(0, a), durationS);
    b = Math.min(Math.max(0, b), durationS);
    if (b - a < MIN_OWN_SEGMENT_S) {
        // Too short: grow it around where it was asked for, inside the file.
        b = Math.min(durationS, a + MIN_OWN_SEGMENT_S);
        a = Math.max(0, b - MIN_OWN_SEGMENT_S);
    }
    return { inS: round1(a), outS: Math.min(durationS, round1(b)) };
}

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
export function enforceStoryboard(raw: unknown, brief: VideoBrief, library: LibraryPicture[] = [], footage: OwnVideo[] = []): { storyboard: Storyboard; changes: string[] } {
    const changes: string[] = [];
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const libraryIds = new Set(library.map((p) => p.id));
    // Only the videos the owner chose for THIS video, and only once they are measured.
    const chosen = new Set(brief.footageAssetIds ?? []);
    const ownById = new Map(footage.filter((v) => chosen.has(v.id) && v.durationS > 0).map((v) => [v.id, v]));
    const ownSound = keepsOwnSound(brief);
    const motions: StillMotion[] = ['push_in', 'pan_right', 'pull_out', 'pan_left'];

    let scenes: Scene[] = (Array.isArray(r.scenes) ? r.scenes : []).slice(0, MAX_SCENES).map((s, i) => {
        const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
        let source: SceneSource = (SCENE_SOURCES as readonly string[]).includes(String(o.source)) ? o.source as SceneSource : 'stock_video';
        const assetId = Number(o.assetId);
        if (source === 'product_photo' && !libraryIds.has(assetId)) {
            source = 'stock_photo';
            changes.push(`Scene ${i + 1}: that picture isn't in your library, so a stock photo is used instead.`);
        }
        let segment: { inS: number; outS: number } | null = null;
        if (source === 'own_video') {
            const own = ownById.get(assetId);
            segment = own ? clampSegment(o.inS, o.outS, own.durationS) : null;
            if (!segment) {
                source = 'stock_video';
                changes.push(`Scene ${i + 1}: that isn't one of the videos you chose, so stock footage is used instead.`);
            } else if (Number(o.inS) !== segment.inS || Number(o.outS) !== segment.outS) {
                changes.push(`Scene ${i + 1}: the cut was moved to fit inside your video.`);
            }
        }
        const beat: Beat = (BEATS as readonly string[]).includes(String(o.beat)) ? o.beat as Beat : 'value';
        const scene: Scene = {
            id: `s${i + 1}`,
            beat,
            voiceover: clip(o.voiceover, 240),
            source,
            targetS: Math.max(MIN_SCENE_S, Number(o.targetS) || brief.lengthS / 5),
        };
        if (segment) {
            scene.assetId = assetId;
            scene.inS = segment.inS;
            scene.outS = segment.outS;
            if (o.tighten === false) scene.tighten = false;
            // Its own sound: the scene IS the segment. Under a voiceover the voice sets the cut.
            if (ownSound) scene.targetS = round1(segment.outS - segment.inS);
        }
        const text = clip(o.onScreenText, 60);
        if (text) scene.onScreenText = text;
        const prompt = clip(o.prompt, 600);
        if (prompt) scene.prompt = prompt;
        const keywords = clip(o.keywords, 60);
        if (keywords) scene.keywords = keywords;
        if (source === 'product_photo') scene.assetId = assetId;
        const name = readNameCaption(o.nameCaption);
        if (name) scene.nameCaption = name;
        if (isStillSource(source)) scene.motion = isStillMotion(o.motion) && o.motion !== 'none' ? o.motion : motions[i % motions.length];
        return scene;
    });

    // Too few scenes is not repairable by rules — the caller re-plans or falls back.
    if (scenes.length < minScenesFor(brief)) {
        changes.push(`The plan had ${scenes.length} scene${scenes.length === 1 ? '' : 's'}; a video needs at least ${minScenesFor(brief)}.`);
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

    // A video in its own sound: a scene with no voiceover line is fine — the footage speaks.
    scenes = fitLength(scenes, brief.lengthS, changes, ownSound ? (s) => s.source === 'own_video' : undefined);

    const music = r.music && typeof r.music === 'object' ? r.music as Record<string, unknown> : null;
    return {
        storyboard: {
            title: clip(r.title, 80) || clip(brief.message, 60) || 'New video',
            caption: clip(r.caption, 600),
            scenes,
            // Kept through an edit (edit_scene re-checks the whole storyboard); never set by the model.
            ...(typeof r.scriptApprovedAt === 'string' && r.scriptApprovedAt ? { scriptApprovedAt: r.scriptApprovedAt } : {}),
            ...(music && Number.isInteger(Number(music.trackId)) && Number(music.trackId) > 0
                ? { music: { trackId: Number(music.trackId), title: clip(music.title, 120), mood: clip(music.mood, 20) } } : {}),
        },
        changes,
    };
}

/**
 * Rescale scene lengths to the asked-for total (±10 %), keeping the hook ≤ 3 s. Pure.
 *
 * `fixed` scenes keep their length: an own-video scene in its own sound IS its segment, and stretching
 * it would play past the cut (or past the file). Only the other scenes take up the difference, and a
 * fixed hook is never shortened — cutting someone off mid-sentence is worse than a long hook.
 */
export function fitLength(scenes: Scene[], lengthS: number, changes: string[] = [], fixed?: (s: Scene) => boolean): Scene[] {
    if (!scenes.length) return scenes;
    const isFixed = (s: Scene) => !!fixed && fixed(s);
    const total = scenes.reduce((a, s) => a + s.targetS, 0);
    const lo = lengthS * 0.9, hi = lengthS * 1.1;
    let out = scenes.map((s) => ({ ...s }));
    if (total < lo || total > hi) {
        const fixedTotal = out.filter(isFixed).reduce((a, s) => a + s.targetS, 0);
        const free = total - fixedTotal;
        const room = lengthS - fixedTotal;
        if (free > 0 && room > 0) {
            const k = room / free;
            out = out.map((s) => (isFixed(s) ? s : { ...s, targetS: Math.max(MIN_SCENE_S, s.targetS * k) }));
            changes.push(`Scene lengths adjusted to make a ${lengthS}-second video.`);
        } else if (free > 0 && fixedTotal > hi) {
            changes.push(`Your clips alone run ${Math.round(fixedTotal)} seconds, longer than the ${lengthS} asked for.`);
        }
    }
    if (out[0].targetS > MAX_HOOK_S && !isFixed(out[0])) {
        const spare = out[0].targetS - MAX_HOOK_S;
        out[0].targetS = MAX_HOOK_S;
        const takers = out.slice(1).filter((s) => !isFixed(s));
        if (takers.length) {
            const share = spare / takers.length;
            for (const s of takers) s.targetS += share;
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
    return `You are a short-form video producer for a small business. You plan short promo videos (vertical 9:16 unless told another shape) that the business can post anywhere or use on its website.

Rules:
- One idea per video. Open with a hook that lands in under 3 seconds. End with the call to action.
- Write the voiceover to be SPOKEN: short sentences, about ${WORDS_PER_SECOND} words per second of scene. No URLs, no hashtags, no emoji.
- On-screen text is optional and short (under 8 words). The voiceover is captioned automatically, so do not repeat it on screen.
- Visual sources, in order of preference: stock_video, stock_photo, product_photo (ONLY with an id from the library list), brand_card (a branded text card — good for the call to action), ai_image, ai_video.
- AI prompts describe a scene with NO words, letters, logos or signs in it. Never use AI to picture the business's own product — use product_photo or stock.
- Stock keywords are 2–4 plain words a stock library would match.
- Use only facts from the business information given. Never invent prices, offers, awards or claims.
- Write for the audience you are given, and make the call to action the thing they should do.
- nameCaption (optional, {"name": "...", "role": "..."}) puts a name caption on a scene where a real person is on screen or speaking. Only use a name given in the brief, the business information or the footage's own words — never invent one.
- When the owner's own footage is listed, build the video mainly FROM it: own_video scenes, each a segment {assetId, inS, outS} in seconds inside that video's length, taken from its usable moments. Fill only real gaps with stock, a branded card or AI. Never use a moment the shot list marks as a problem.

Return STRICT JSON only:
{"title": "...", "caption": "a post caption, 1–3 sentences", "scenes": [{"beat": "hook|problem|value|proof|cta", "voiceover": "...", "onScreenText": "...", "source": "own_video|stock_video|stock_photo|product_photo|brand_card|ai_image|ai_video", "keywords": "...", "prompt": "...", "assetId": 123, "inS": 0, "outS": 4.5, "motion": "push_in|pull_out|pan_left|pan_right", "nameCaption": {"name": "...", "role": "..."}, "targetS": 4}]}`;
}

export function storyboardUserPrompt(args: {
    brief: VideoBrief;
    businessName: string;
    businessFacts: string;
    library: LibraryPicture[];
    today: string;
    feedback?: string | null;
    /** The script's language by name ("French"); absent or English = no instruction. */
    language?: string | null;
    /** The owner's footage with its shot lists (src/lib/footage.ts footagePlannerBlock); absent = none. */
    footageBlock?: string | null;
    /** The suggested edits the owner ticked, and the ones they left unticked (footage videos only). */
    acceptedEdits?: string[];
    declinedEdits?: string[];
    /** Rewrite the words only, keeping every scene's picture: the current storyboard to rewrite. */
    scriptOf?: Storyboard | null;
    /** Change only these scenes, as the owner's notes on the finished video say. */
    sceneNotes?: { storyboard: Storyboard; notes: Record<string, string[]> } | null;
}): string {
    const { brief } = args;
    const allow = brief.allowAi === 'stock_only' ? 'Do NOT use ai_image or ai_video.'
        : brief.allowAi === 'ai_first' ? `AI sources are welcome (at most ${MAX_AI_CLIPS} ai_video scenes).`
        : `Prefer stock; AI is allowed where stock would not fit (at most ${MAX_AI_CLIPS} ai_video scenes).`;
    return [
        `Today is ${args.today}.`,
        brief.shape && brief.shape !== '9:16' ? `SHAPE: the video is ${SHAPE_LABELS[brief.shape]}, not vertical — frame every scene for that.` : '',
        `BUSINESS: ${args.businessName}`,
        args.businessFacts ? `BUSINESS INFORMATION:\n${args.businessFacts}` : '',
        brief.footageAssetIds?.length
            ? `VIDEO: a ${brief.lengthS}-second ${clip(brief.purpose, 60) || 'promo'} video, 1–${MAX_SCENES} scenes, about ${brief.lengthS} seconds. One continuous take is ONE own_video scene — never split a sentence across scenes; a closing branded card is its own scene.`
            : `VIDEO: a ${brief.lengthS}-second ${clip(brief.purpose, 60) || 'promo'} video, ${MIN_SCENES}–${MAX_SCENES} scenes, scene lengths adding up to ${brief.lengthS} seconds.`,
        `WHAT IT MUST SAY: ${clip(brief.message, 600)}`,
        brief.audience ? `WHO IT'S FOR: ${clip(brief.audience, 200)} — pick words, examples and pace for them.` : '',
        brief.goal ? `WHAT THEY SHOULD DO AFTER WATCHING: ${clip(brief.goal, 200)} — build towards it, and end on it.` : '',
        brief.cta ? `CALL TO ACTION (use these words in the last scene): ${clip(brief.cta, 200)}` : '',
        keepsOwnSound(brief)
            ? 'No voiceover — the video keeps the footage\'s OWN sound. Leave voiceover empty. An own_video scene plays exactly its segment, so cut segments at natural pauses, never mid-sentence. Its targetS is ignored. Pauses, "um"s and repeated takes inside a segment are taken out automatically afterwards, so choose whole sentences and do not chop a segment up to remove them yourself. Use onScreenText where the footage needs words.'
            : brief.voiceover ? 'It has a voiceover — every scene needs a voiceover line.' : 'No voiceover — leave voiceover empty and use onScreenText to carry the message.',
        // A footage video always says it: the shot list quotes what was SAID, and a mis-heard language
        // there wrote the whole post in Welsh for an English speaker (staging, 2026-11-09).
        args.language && (args.language !== 'English' || args.footageBlock)
            ? `LANGUAGE: write every voiceover line, every onScreenText and the caption in ${args.language}. Keep search keywords and AI prompts in English.`
            : '',
        allow,
        args.library.length
            ? `LIBRARY PICTURES you may use as product_photo (id: name):\n${args.library.slice(0, 30).map((p) => `${p.id}: ${clip(p.name, 80)}`).join('\n')}`
            : 'There are no library pictures — do not use product_photo.',
        args.footageBlock ? args.footageBlock : '',
        args.acceptedEdits?.length ? `EDITS THE OWNER ACCEPTED (apply every one):\n${args.acceptedEdits.map((e) => `- ${clip(e, 300)}`).join('\n')}` : '',
        args.declinedEdits?.length ? `EDITS THE OWNER TURNED DOWN (do NOT apply these):\n${args.declinedEdits.map((e) => `- ${clip(e, 300)}`).join('\n')}` : '',
        args.feedback ? `THE OWNER'S NOTES ON THE LAST VERSION (follow them): ${clip(args.feedback, 600)}` : '',
        args.scriptOf ? scriptOnlyBlock(args.scriptOf) : '',
        args.sceneNotes ? sceneNotesBlock(args.sceneNotes.storyboard, args.sceneNotes.notes) : '',
    ].filter(Boolean).join('\n\n');
}

/** The current scenes, numbered, as the planner sees them for a words-only change. Pure. */
function scenesListing(sb: Storyboard): string {
    return sb.scenes.map((s, i) => `${i + 1}. [${s.beat}; picture: ${s.source}${s.keywords ? ` "${clip(s.keywords, 60)}"` : s.prompt ? ` "${clip(s.prompt, 80)}"` : ''}] voiceover: "${clip(s.voiceover, 240)}"${s.onScreenText ? `; on screen: "${clip(s.onScreenText, 60)}"` : ''}`).join('\n');
}

/** "Rewrite the script": same scenes, same pictures, new words. Pure. */
export function scriptOnlyBlock(sb: Storyboard): string {
    return `REWRITE THE SCRIPT ONLY. These are the current ${sb.scenes.length} scenes. Return exactly ${sb.scenes.length} scenes in the same order, changing only "voiceover", "onScreenText" and the caption. Copy every other field as it is — the pictures are already chosen and must not change.\n${scenesListing(sb)}`;
}

/** "Make a new version from my notes": change only the noted scenes. Pure. */
export function sceneNotesBlock(sb: Storyboard, notes: Record<string, string[]>): string {
    const lines = sb.scenes.map((s, i) => notes[s.id]?.length ? `- scene ${i + 1}: ${notes[s.id].map((n) => `"${clip(n, 300)}"`).join('; ')}` : '').filter(Boolean);
    return `CHANGE ONLY THE NOTED SCENES. The owner watched the finished video and left notes on these scenes:\n${lines.join('\n')}\nThese are the current ${sb.scenes.length} scenes. Return exactly ${sb.scenes.length} scenes in the same order. Change a noted scene only as far as its notes ask — its words, on-screen text or name caption, and its picture (source, keywords or prompt) only if a note asks for a different picture. Copy every other scene exactly as it is.\n${scenesListing(sb)}`;
}

/** Pull the JSON object out of a model reply. Pure; null when there is none. */
export function parseStoryboardJson(text: string): unknown | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
