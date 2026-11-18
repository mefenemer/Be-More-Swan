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
import { readSceneText, type TextAnim, type TextPos, type TextStyle, type TextWhen } from './scene-text';
import { readSceneCover, type SceneCover } from './scene-cover';
import { PRESENTER_KEY_SCENES, presenterById, readBriefPresenter, type BriefPresenter } from './presenters';
import { COUNTDOWN_MAX_ITEMS, COUNTDOWN_MIN_ITEMS, COUNTDOWN_VIDEO_BRIEF, countdownNumber, fixListCount } from '../utils/top-lists';

export const SCENE_SOURCES = ['stock_video', 'stock_photo', 'ai_video', 'ai_image', 'brand_card', 'product_photo', 'own_video', 'ai_presenter'] as const;
export type SceneSource = typeof SCENE_SOURCES[number];
export const BEATS = ['hook', 'problem', 'value', 'proof', 'cta'] as const;

/** The owner's struck-out words, kept to the segment, at most 400, rounded to 0.01 s. Pure. */
export function readCutWords(raw: unknown, inS: number, outS: number): Array<{ start: number; end: number }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ start: number; end: number }> = [];
    for (const w of raw.slice(0, 400)) {
        const start = Number((w as { start?: unknown })?.start), end = Number((w as { end?: unknown })?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < inS - 0.05 || end > outS + 0.05) continue;
        out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
    }
    return out.sort((a, b) => a.start - b.start);
}
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
    /**
     * The owner's own videos used ONLY as screens over or beside an AI presenter (A3, walkthrough plan §11.7): never
     * scenes of their own and never their sound, so no footage review. Only with a presenter.
     */
    screenAssetIds?: number[];
    /** Cut pauses, "um"s and repeated takes out of own footage in its own sound. Absent = on. */
    tighten?: boolean;
    /** The finished video's shape. Absent = vertical 9:16 (every video before 2026-11-09). */
    shape?: VideoShape;
    /** Who it's for, and what they should do after watching (2026-11-10). Fed to the planner. */
    audience?: string | null;
    goal?: string | null;
    /** A colour look over every scene (src/lib/video-look.ts). Absent = natural. */
    look?: VideoLook | null;
    /**
     * An AI clip on its own (src/lib/ai-clip.ts): one ai_video scene, no voiceover, music or captions. The
     * owner sees its first frame (the scene's assetId, an AI picture) before the clip is made from it.
     */
    clip?: { style: string; lengthS: number; description: string; sound?: boolean } | null;
    /** The voiceover is the owner's own recordings, not an AI voice (src/utils/own-voice.ts). Never both. */
    ownVoice?: boolean | null;
    /** How loud the music sits: 'quiet' | 'normal' | 'loud' (src/lib/video-music.ts). Absent = normal. */
    musicLevel?: 'quiet' | 'normal' | 'loud' | null;
    /** How name captions look (src/lib/lower-third.ts). Absent = 'bar'. */
    lowerThird?: LowerThirdStyle | null;
    /** This video is another shape of video N (one click "Make it in the other shapes"). */
    shapeOf?: number | null;
    /**
     * An AI presenter speaks the voiceover to camera in some scenes (docs/video-producer-screen-walkthrough-plan.md
     * §11, A2): one of src/public/presenter-catalogue.json, in their voice for the video's language. Only when the
     * workspace has the ai_presenter flag (video-projects create strips it otherwise). Never with own footage.
     */
    presenter?: BriefPresenter | null;
    /** "Another track": the library track the next build must not pick again. */
    avoidTrackId?: number | null;
    /**
     * A countdown ("Top 3…", Top lists Phase 3): the hook names the count, one scene per item counting
     * down to 1, then the call to action. Made-up videos only — own footage has its own order.
     */
    countdown?: boolean;
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
    /**
     * Words the owner struck out on the Videos tab ("Edit the words"), by their times in the source video.
     * Cut whether or not the scene is tightened. Only from the owner's own edit (video-projects edit_scene).
     */
    cutWords?: Array<{ start: number; end: number }>;
    /** Who is on screen, as a lower-third name caption (src/lib/lower-third.ts). */
    nameCaption?: NameCaption;
    /**
     * Walkthrough layout (src/lib/scene-cover.ts): a screen shown with or instead of the presenter while they
     * keep talking. Own-video scenes only. Absent = the presenter full frame.
     */
    cover?: SceneCover;
    /** The words' place, timing, look and entrance (src/lib/scene-text.ts). Absent = as before 2026-11-10. */
    textPos?: TextPos;
    textWhen?: TextWhen;
    textStyle?: TextStyle;
    textAnim?: TextAnim;
    /**
     * The owner's own recording of this scene's line (src/utils/own-voice.ts), and its length. Set only
     * by the server from an upload; a scene keeps it while its words stay the same (keepRecordings).
     */
    voiceAssetId?: number;
    voiceS?: number;
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
    /**
     * The track made for this video (assetId, Stable Audio — src/lib/video-music.ts), or the library
     * track an older build chose (trackId). Kept so a new version or another shape reuses it free.
     */
    music?: { trackId?: number; assetId?: number; title: string; mood: string } | null;
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
export function minScenesFor(brief: Pick<VideoBrief, 'footageAssetIds' | 'clip'>): number {
    return brief.footageAssetIds?.length || brief.clip ? 1 : MIN_SCENES;
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
    if (source === 'ai_video' || source === 'ai_presenter') return 'stock_video';
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
    // A screen may be any of the brief's own videos: its footage, or (with a presenter) its screen recordings (A3).
    const screenIds = new Set([...(brief.footageAssetIds ?? []), ...(brief.screenAssetIds ?? [])]);
    const screenLens = new Map(footage.filter((v) => screenIds.has(v.id) && v.durationS > 0).map((v) => [v.id, v.durationS]));
    if (brief.screenAssetIds?.some((id) => !screenLens.has(id))) changes.push('A screen recording you chose has no length yet, so it isn\'t used. Upload it again, or use it once with “Use my own footage”.');
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
            const cw = readCutWords(o.cutWords, segment.inS, segment.outS);
            if (cw.length) scene.cutWords = cw;
            // Its own sound: the scene IS the segment. Under a voiceover the voice sets the cut.
            if (ownSound) scene.targetS = round1(segment.outS - segment.inS);
            // A screen over (or beside) the presenter: only the brief's own videos or the library's pictures.
            const cover = readSceneCover(o.cover, { own: new Map([...ownById].map(([id, v]) => [id, v.durationS])), library: libraryIds });
            if (cover) scene.cover = cover;
            else if (o.cover) changes.push(`Scene ${i + 1}: that screen isn't one of your chosen videos or pictures, so the presenter shows full frame.`);
        }
        // The AI presenter over (or beside) a screen (A3): a bubble or a window, never "screen only" — a presenter who
        // is heard but not seen would be paid for by the second and never shown.
        if (source === 'ai_presenter' && o.cover) {
            const cover = readSceneCover(o.cover, { own: screenLens, library: libraryIds });
            if (cover && cover.layout !== 'cover') scene.cover = cover;
            else changes.push(cover
                ? `Scene ${i + 1}: the presenter is shown with the screen in a bubble, not hidden behind it.`
                : `Scene ${i + 1}: that screen isn't one of your chosen videos or pictures, so the presenter shows full frame.`);
            if (cover && cover.layout === 'cover') scene.cover = { ...cover, layout: 'bubble' };
        }
        const text = clip(o.onScreenText, 60);
        if (text) { scene.onScreenText = text; Object.assign(scene, readSceneText(o as Record<string, unknown>)); }
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
    // The AI presenter (A2): only with a presenter in the brief, only on a scene with words to say, and — unless the
    // owner chose "Show me throughout" — in at most PRESENTER_KEY_SCENES scenes, the earliest kept (D-A7).
    const presenter = readBriefPresenter(brief.presenter);
    let presenterScenes = 0;
    for (const s of scenes) {
        if (s.source !== 'ai_presenter') continue;
        const i = scenes.indexOf(s) + 1;
        if (!presenter) { s.source = 'stock_video'; delete s.cover; if (!s.keywords) s.keywords = clip(s.voiceover, 60).split(' ').slice(0, 4).join(' '); changes.push(`Scene ${i}: this video has no presenter, so stock footage is used.`); continue; }
        if (!s.voiceover.trim()) { s.source = 'stock_video'; delete s.cover; if (!s.keywords) s.keywords = 'business'; changes.push(`Scene ${i}: the presenter needs words to say, so stock footage is used.`); continue; }
        presenterScenes++;
        // The call to action (the last scene) keeps them when it uses them, so the others share the remaining places;
        // when it doesn't, the earliest three keep them (review of #721).
        const isLast = s === scenes[scenes.length - 1];
        const lastIsPresenter = scenes[scenes.length - 1].source === 'ai_presenter';
        // With screen recordings (A3) the presenter guides the whole walkthrough, so the key-moment limit doesn't apply —
        // counting only screens that can be laid out (measured), never ones that were dropped (review of #725).
        const walkthrough = [...(brief.screenAssetIds ?? [])].some((id) => screenLens.has(id));
        if (!presenter.throughout && !walkthrough && !isLast && presenterScenes > PRESENTER_KEY_SCENES - (lastIsPresenter ? 1 : 0)) {
            s.source = 'stock_video';
            delete s.cover;   // a screen beside the presenter means nothing on a stock scene (review of #725)
            if (!s.keywords) s.keywords = clip(s.voiceover, 60).split(' ').slice(0, 4).join(' ');
            changes.push(`The presenter appears in at most ${PRESENTER_KEY_SCENES} scenes — scene ${i} uses stock footage.`);
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

    if (brief.countdown) scenes = fixCountdown(scenes, changes);

    // A video in its own sound: a scene with no voiceover line is fine — the footage speaks.
    scenes = fitLength(scenes, brief.lengthS, changes, ownSound ? (s) => s.source === 'own_video' : undefined);

    const music = r.music && typeof r.music === 'object' ? r.music as Record<string, unknown> : null;
    return {
        storyboard: {
            title: brief.countdown && scenes.length >= 3
                ? fixListCount(clip(r.title, 80) || clip(brief.message, 60) || 'New video', scenes.length - 2)
                : clip(r.title, 80) || clip(brief.message, 60) || 'New video',
            caption: clip(r.caption, 600),
            scenes,
            // Kept through an edit (edit_scene re-checks the whole storyboard); never set by the model.
            ...(typeof r.scriptApprovedAt === 'string' && r.scriptApprovedAt ? { scriptApprovedAt: r.scriptApprovedAt } : {}),
            ...(music && Number.isInteger(Number(music.assetId)) && Number(music.assetId) > 0
                ? { music: { assetId: Number(music.assetId), title: clip(music.title, 120), mood: clip(music.mood, 20) } }
                : music && Number.isInteger(Number(music.trackId)) && Number(music.trackId) > 0
                    ? { music: { trackId: Number(music.trackId), title: clip(music.title, 120), mood: clip(music.mood, 20) } } : {}),
        },
        changes,
    };
}

/**
 * A countdown's numbers, made true in code (Top lists plan §5.1: the count is computed, never trusted).
 * The item scenes are the ones between the hook and the call to action. Each gets its place in the
 * countdown on screen ("#3 …" down to "#1 …"), keeping any label the planner wrote, and the hook's
 * count is rewritten to the number of items there really are. Too few items is said, not padded.
 * Pure; returns new scenes.
 */
export function fixCountdown(scenes: Scene[], changes: string[] = []): Scene[] {
    if (scenes.length < 3) return scenes;
    const out = scenes.map((s) => ({ ...s }));
    const items = out.slice(1, -1);
    const n = items.length;
    if (n < COUNTDOWN_MIN_ITEMS) changes.push(`A countdown needs at least ${COUNTDOWN_MIN_ITEMS} items; this plan has ${n}.`);
    if (n > COUNTDOWN_MAX_ITEMS) changes.push(`A countdown works best with ${COUNTDOWN_MAX_ITEMS} items or fewer; this plan has ${n}.`);
    let renumbered = false;
    items.forEach((s, i) => {
        const place = n - i;
        const label = String(s.onScreenText ?? '').replace(/^\s*(?:#|no\.?\s*|number\s+)?\d{1,2}\b[.):\-–—]?\s*/i, '').trim();
        const next = clip(`#${place}${label ? ` ${label}` : ''}`, 60);
        if (countdownNumber(s.onScreenText) !== place) renumbered = true;
        s.onScreenText = next;
    });
    if (renumbered) changes.push('The countdown numbers on screen now run down to #1.');
    const hook = out[0];
    const fixedVo = fixListCount(hook.voiceover, n);
    const fixedText = hook.onScreenText ? fixListCount(hook.onScreenText, n) : hook.onScreenText;
    if (fixedVo !== hook.voiceover || fixedText !== hook.onScreenText) {
        hook.voiceover = fixedVo;
        if (fixedText) hook.onScreenText = fixedText;
        changes.push(`The hook now says ${n}, the number of items in the countdown.`);
    }
    return out;
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
    words: Array<{ start: number; end: number; word?: string }>,
): number[] | null {
    const counts = storyboard.scenes.map((s) => (s.voiceover ? s.voiceover.split(/\s+/).filter(Boolean).length : 0));
    const planned = counts.reduce((a, b) => a + b, 0);
    if (!planned || !words.length) return null;
    // Scale planned counts to the number of words actually heard.
    const k = words.length / planned;
    const starts: number[] = [];
    let idx = 0;
    for (let i = 0; i < counts.length; i++) {
        // A scene is whole sentences, so its first word starts a sentence. The count estimate drifts when the
        // transcription spells words differently ("fifteen minute" heard as "15-minute": an AI presenter's last
        // clip started on "online", missing "Book", staging 2026-11-18). So the cut moves to the nearest sentence
        // start within SNAP_WORDS of the estimate (snapToPause) — never back past the previous scene's first word.
        // Only a cut between two scenes that both have lines moves: next to a silent scene the estimate already sits
        // where the next line starts, and snapping it would hand those first words to the wrong scene (review of #723).
        // A count that runs past the last heard word (the transcript merged words) still gets a cut inside the speech,
        // so a short last line keeps its first word (review of #723).
        if (i > 0 && counts[i] > 0 && idx >= words.length) idx = words.length - 1;
        // …and only where the previous scene's line ENDS a sentence: a line that stops mid-sentence ("Our fresh coffee"
        // / "is roasted daily.") already has the right cut from the count (review of #723).
        const endsSentence = /[.?!…]["'”’)\]]*$/.test((storyboard.scenes[i - 1]?.voiceover ?? '').trim());
        if (i > 0 && endsSentence && counts[i - 1] > 0 && counts[i] > 0 && idx > 0 && idx < words.length) idx = snapToPause(words, idx, starts.length ? wordIndexAt(words, starts[starts.length - 1]) + 1 : 1);
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

/** How far (in words) a scene cut may move to land in a pause. */
export const SNAP_WORDS = 3;

/** The index of the word starting at `t` (or the last one before it). Pure. */
function wordIndexAt(words: Array<{ start: number }>, t: number): number {
    let i = 0;
    while (i + 1 < words.length && words[i + 1].start <= t + 1e-6) i++;
    return i;
}

/** A gap between words shorter than this isn't a pause. */
export const MIN_PAUSE_S = 0.12;

/**
 * The word index NEAREST `idx` (within SNAP_WORDS, never below `min`) that starts a sentence — where a new scene
 * starts; equally near, the longer pause wins. A sentence start is the word after one ending in . ? or ! when the
 * transcript gives the words' text (ElevenLabs does), else the word after a pause of MIN_PAUSE_S or more. The
 * estimate stands when it already starts a sentence, or none is near. Nearest, not longest (a longer pause further
 * on jumped a whole sentence), and sentence ends, not any pause (a comma's pause moved a right cut — reviews of
 * #723). Pure.
 */
export function snapToPause(words: Array<{ start: number; end: number; word?: string }>, idx: number, min: number): number {
    const gap = (j: number) => (j > 0 && j < words.length ? words[j].start - words[j - 1].end : -1);
    const END = /[.?!…]["'”’)\]]*$/;
    // Punctuation only when the transcript has some: the fallback transcriber returns bare words, and then a pause
    // is the only sign of a sentence end.
    const punctuated = words.some((w) => typeof w.word === 'string' && END.test(w.word.trim()));
    const startsSentence = (j: number) => {
        if (j <= 0 || j >= words.length) return false;
        const prev = words[j - 1].word;
        return punctuated && typeof prev === 'string' ? END.test(prev.trim()) : gap(j) >= MIN_PAUSE_S;
    };
    if (idx >= min && startsSentence(idx)) return idx;
    let best = idx, bestDist = Infinity, bestGap = -1;
    for (let j = Math.max(min, idx - SNAP_WORDS); j <= Math.min(words.length - 1, idx + SNAP_WORDS); j++) {
        const g = gap(j), dist = Math.abs(j - idx);
        if (!startsSentence(j)) continue;
        if (dist < bestDist || (dist === bestDist && g > bestGap)) { best = j; bestDist = dist; bestGap = g; }
    }
    // Never onto (or before) the previous cut: that would leave the previous scene with no words (review of #723).
    return Math.max(best, min);
}

/** Credits a storyboard will cost before anything is made (shown on the button). Pure. */
export function estimateCredits(storyboard: Storyboard, brief: VideoBrief, costs: { image: number; video: number; voiceover: number }): number {
    let n = 0;
    for (const s of storyboard.scenes) {
        if (s.source === 'ai_image') n += costs.image;
        if (s.source === 'ai_video' || s.source === 'ai_presenter') n += costs.video;
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
- Where on-screen text goes (optional; leave all four out and it sits clear of the captions for the whole scene): "textPos" top | middle | bottom — never where the captions are (the brief says where); "textWhen" scene | first | last | words (the whole scene, its first or last 3 seconds, or only while that scene's line is spoken — good for a key phrase or the call to action); "textStyle" dark | plain | brand (a brand-colour box suits the call to action); "textAnim" rise | fade | pop | none. Use them sparingly: most scenes need none.
- Visual sources, in order of preference: stock_video, stock_photo, product_photo (ONLY with an id from the library list), brand_card (a branded text card — good for the call to action), ai_image, ai_video.
- ai_presenter ONLY when the brief names a PRESENTER: that person speaks the scene's voiceover line to camera (so the scene must have one). No keywords or prompt needed. With SCREEN RECORDINGS listed, an ai_presenter scene may add "cover" ({"layout": "bubble" | "window", "source": "own_video", "assetId": <id>, "inS": <seconds>}) to show a recording with the presenter in a corner bubble or the recording in a corner window.
- AI prompts describe a scene with NO words, letters, logos or signs in it. Never use AI to picture the business's own product — use product_photo or stock.
- Stock keywords are 2–4 plain words a stock library would match.
- Use only facts from the business information given. Never invent prices, offers, awards or claims.
- Write for the audience you are given, and make the call to action the thing they should do.
- nameCaption (optional, {"name": "...", "role": "..."}) puts a name caption on a scene where a real person is on screen or speaking. Only use a name given in the brief, the business information or the footage's own words — never invent one.
- When the owner's own footage is listed, build the video mainly FROM it: own_video scenes, each a segment {assetId, inS, outS} in seconds inside that video's length, taken from its usable moments. Fill only real gaps with stock, a branded card or AI. Never use a moment the shot list marks as a problem.

Return STRICT JSON only:
{"title": "...", "caption": "a post caption, 1–3 sentences", "scenes": [{"beat": "hook|problem|value|proof|cta", "voiceover": "...", "onScreenText": "...", "textPos": "top|middle|bottom", "textWhen": "scene|first|last|words", "textStyle": "dark|plain|brand", "textAnim": "rise|fade|pop|none", "source": "own_video|stock_video|stock_photo|product_photo|brand_card|ai_image|ai_video", "keywords": "...", "prompt": "...", "assetId": 123, "inS": 0, "outS": 4.5, "motion": "push_in|pull_out|pan_left|pan_right", "nameCaption": {"name": "...", "role": "..."}, "targetS": 4}]}`;
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
    /** The owner's screen recordings beside an AI presenter (A3): listed for covers, never cut into scenes. */
    screens?: OwnVideo[];
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
        brief.countdown && !brief.footageAssetIds?.length ? COUNTDOWN_VIDEO_BRIEF : '',
        brief.audience ? `WHO IT'S FOR: ${clip(brief.audience, 200)} — pick words, examples and pace for them.` : '',
        brief.goal ? `WHAT THEY SHOULD DO AFTER WATCHING: ${clip(brief.goal, 200)} — build towards it, and end on it.` : '',
        brief.cta ? `CALL TO ACTION (use these words in the last scene): ${clip(brief.cta, 200)}` : '',
        presenterBlock(brief, args.screens ?? []),
        // Where the captions sit, so the words placed on screen keep clear of them (scene-text.ts).
        brief.captions === false ? 'CAPTIONS: off — on-screen text may sit anywhere.' : `CAPTIONS: at the ${brief.captionStyle?.position ?? 'bottom'} of the frame — never put textPos there.`,
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

/** The planner's instruction for a video with an AI presenter (A2, D-A7). Empty without one. Pure. */
export function presenterBlock(brief: Pick<VideoBrief, 'presenter' | 'footageAssetIds' | 'screenAssetIds'>, screens: OwnVideo[] = []): string {
    const bp = readBriefPresenter(brief.presenter);
    const p = bp ? presenterById(bp.id) : null;
    if (!bp || !p || brief.footageAssetIds?.length) return '';
    // A walkthrough (A3): the presenter in a round bubble over the owner's screen recordings, full frame at the
    // opening and the call to action. Each recording is shown in order, a stretch per scene.
    const mine = screens.filter((v) => (brief.screenAssetIds ?? []).includes(v.id));
    if (mine.length) {
        const list = mine.map((v) => `id ${v.id} "${clip(v.name, 60)}" (${Math.round(v.durationS)} s)`).join('; ');
        return `PRESENTER WITH SCREEN RECORDINGS: ${p.name}, an AI presenter, walks the viewer through the business's own screen recordings — ${list}. Open and close with "ai_presenter" full frame (no cover). Every scene in between is "ai_presenter" with "cover": {"layout": "bubble", "source": "own_video", "assetId": <a recording's id>, "inS": <seconds into it>} — move through each recording in order, a fresh stretch per scene (inS growing by about the scene's length), never past its end. Use "layout": "window" instead where the presenter's face matters more than the screen. Never "layout": "cover".`;
    }
    return bp.throughout
        ? `PRESENTER: ${p.name}, an AI presenter, speaks to camera. Use source "ai_presenter" for every scene where a person speaking suits the line (most of them); show the product or place with stock or the business's own pictures where that says more.`
        : `PRESENTER: ${p.name}, an AI presenter, speaks to camera at the key moments only: use source "ai_presenter" for the opening scene, the call to action, and at most one other scene that matters most. Every other scene uses stock, the business's own pictures or a branded card.`;
}
