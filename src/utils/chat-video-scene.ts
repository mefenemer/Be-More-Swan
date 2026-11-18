// src/utils/chat-video-scene.ts — the Video Producer's video_scene_edit card (owner 2026-11-05): one scene of
// a storyboard changed from the docked chat, shown before and after. The click sends it to video-projects.ts
// `edit_scene`, the same action as "Change" on the scene, so its moderation and storyboard rules apply.
//
// It only changes the plan. Making the video is what spends, and that stays the button on the video, which
// states its cost: a chat card never spends, even when it swaps a stock clip for an AI one.
//
// The model names a scene by the number the user sees; this finds the real scene in the stored storyboard, and
// shows what is there NOW rather than what the model says is there. Rebuilt here because uiElementJson is stored
// and re-rendered on every reload. Own footage isn't offered: nothing can place a clip of theirs in a scene yet.
// tests/video-chat-pane.test.ts.

import type { Scene, Storyboard } from '../lib/storyboard';
import { readNameCaption, type NameCaption } from '../lib/lower-third';
import { readSceneText, type SceneTextFields } from '../lib/scene-text';
import { isBubbleSize, isCorner, isCoverLayout, type BubbleSize, type Corner, type CoverLayout, type SceneCover } from '../lib/scene-cover';

export const VIDEO_SCENE_EDIT_TYPE = 'video_scene_edit';

/** product_photo needs a picture of theirs, which a card can't choose. */
// ai_presenter only matters where the video has a presenter: edit_scene's storyboard rules turn it into stock otherwise.
const CARD_SOURCES = ['stock_video', 'stock_photo', 'ai_video', 'ai_image', 'brand_card', 'ai_presenter'] as const;
type CardSource = typeof CARD_SOURCES[number];

export interface VideoSceneRequest {
    projectId: number; scene: number; summary: string | null;
    voiceover?: string; onScreenText?: string; source?: CardSource; picture?: string;
    /** A name caption for the scene; null takes it off. */
    nameCaption?: NameCaption | null;
    /** Where, when, how the words look and appear (scene-text.ts). Only valid values travel. */
    text?: SceneTextFields;
    /** Words to cut from one of the owner's own clips, exactly as said ("Edit the words"); matched on the server. */
    cutPhrase?: string;
    /** Walkthrough layout on an own-footage scene (scene-cover.ts): 'presenter' takes the screen off. */
    layout?: CoverLayout | 'presenter';
    /** What's on the screen: one of the video's own videos (by id) from a second, or stock found by words. */
    screenVideo?: number; screenStartS?: number; screenSearch?: string;
    corner?: Corner; bubbleSize?: BubbleSize;
}
export interface VideoSceneCard {
    type: typeof VIDEO_SCENE_EDIT_TYPE; projectId: number; scene: number; sceneId: string; summary: string | null;
    /** What edit_scene is sent. */
    patch: { voiceover?: string; onScreenText?: string; source?: CardSource; keywords?: string; prompt?: string; nameCaption?: NameCaption | null; cutPhrase?: string; cover?: SceneCover | null } & SceneTextFields;
    now: { voiceover: string; onScreenText: string };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function videoSceneRequestFromUiElement(uiElement: unknown): VideoSceneRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== VIDEO_SCENE_EDIT_TYPE) return null;
    const projectId = Number(ui.projectId);
    const scene = Number(ui.scene);
    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(scene) || scene <= 0) return null;
    const req: VideoSceneRequest = { projectId, scene, summary: str(ui.summary, 300) || null };
    const voiceover = str(ui.voiceover, 240);
    if (voiceover) req.voiceover = voiceover;
    // An empty string is a real answer here: take the words off the screen.
    if (typeof ui.onScreenText === 'string') req.onScreenText = str(ui.onScreenText, 60);
    if ((CARD_SOURCES as readonly unknown[]).includes(ui.source)) req.source = ui.source as CardSource;
    const picture = str(ui.picture, 120);
    if (picture) req.picture = picture;
    if (ui.nameCaption === null || (ui.nameCaption && typeof ui.nameCaption === 'object' && !String((ui.nameCaption as Record<string, unknown>).name ?? '').trim())) req.nameCaption = null;
    else if (ui.nameCaption) { const nc = readNameCaption(ui.nameCaption); if (nc) req.nameCaption = nc; }
    const text = readSceneText(ui);
    if (Object.keys(text).length) req.text = text;
    const cutPhrase = str(ui.cutPhrase, 200);
    if (cutPhrase) req.cutPhrase = cutPhrase;
    if (ui.layout === 'presenter' || isCoverLayout(ui.layout)) req.layout = ui.layout as VideoSceneRequest['layout'];
    const sv = Number(ui.screenVideo);
    if (Number.isInteger(sv) && sv > 0) req.screenVideo = sv;
    const st = Number(ui.screenStartS);
    if (Number.isFinite(st) && st >= 0 && ui.screenStartS != null) req.screenStartS = Math.round(st * 10) / 10;
    const ss = str(ui.screenSearch, 80);
    if (ss) req.screenSearch = ss;
    if (isCorner(ui.corner)) req.corner = ui.corner;
    if (isBubbleSize(ui.bubbleSize)) req.bubbleSize = ui.bubbleSize;
    const layoutAsked = req.layout != null || req.screenVideo != null || req.screenStartS != null || req.screenSearch != null || req.corner != null || req.bubbleSize != null;
    return req.voiceover != null || req.onScreenText != null || req.source != null || req.picture != null || req.nameCaption !== undefined || req.text || req.cutPhrase || layoutAsked ? req : null;
}

/** The card for this scene of this storyboard. Null when there is no such scene, or nothing would change. */
export function videoSceneCard(req: VideoSceneRequest, storyboard: Storyboard | null | undefined, opts: { ownVideoIds?: number[] } = {}): VideoSceneCard | null {
    const scene: Scene | undefined = storyboard?.scenes?.[req.scene - 1];
    if (!scene) return null;
    const patch: VideoSceneCard['patch'] = {};
    if (req.voiceover != null && req.voiceover !== scene.voiceover) patch.voiceover = req.voiceover;
    if (req.onScreenText != null && req.onScreenText !== (scene.onScreenText || '')) patch.onScreenText = req.onScreenText;
    if (req.source != null && req.source !== scene.source) patch.source = req.source;
    if (req.picture != null) {
        const source = req.source ?? scene.source;
        if (source === 'ai_image' || source === 'ai_video') patch.prompt = req.picture;
        else patch.keywords = req.picture;
    }
    if (req.nameCaption !== undefined && JSON.stringify(req.nameCaption) !== JSON.stringify(scene.nameCaption ?? null)) patch.nameCaption = req.nameCaption;
    if (req.cutPhrase && scene.source === 'own_video') patch.cutPhrase = req.cutPhrase;
    // A layout only on their own footage (edit_scene re-checks the screen is one of the video's own videos).
    // …and on an AI presenter's scene (A3): the presenter in a bubble over a screen, or the screen in a window.
    if (scene.source === 'own_video' || scene.source === 'ai_presenter') {
        // Only one of THIS video's own videos can be the screen: edit_scene would drop any other and leave the
        // presenter full frame, so the card never offers it.
        const ownOk = req.screenVideo == null || (opts.ownVideoIds ?? []).includes(req.screenVideo);
        const cover = ownOk ? coverFromRequest(req, scene.cover) : undefined;
        if (cover !== undefined && JSON.stringify(cover) !== JSON.stringify(scene.cover ?? null)) patch.cover = cover;
    }
    // Text placement only means something on words over a picture (a branded card draws its own).
    if (req.text && scene.source !== 'brand_card' && (req.onScreenText ?? scene.onScreenText)) {
        for (const k of ['textPos', 'textWhen', 'textStyle', 'textAnim'] as const) {
            const v = req.text[k];
            if (v && v !== scene[k]) (patch as Record<string, unknown>)[k] = v;
        }
    }
    if (!Object.keys(patch).length) return null;
    return {
        type: VIDEO_SCENE_EDIT_TYPE, projectId: req.projectId, scene: req.scene, sceneId: scene.id, summary: req.summary, patch,
        now: { voiceover: scene.voiceover || '', onScreenText: scene.onScreenText || '' },
    };
}

/**
 * The cover a card asks for, from the scene's current one: undefined = no layout change asked, null = the
 * presenter full frame. A new screen needs a source: their video, or search words (stock footage). Pure.
 */
export function coverFromRequest(req: VideoSceneRequest, current: SceneCover | undefined): SceneCover | null | undefined {
    const asked = req.layout != null || req.screenVideo != null || req.screenStartS != null || req.screenSearch != null || req.corner != null || req.bubbleSize != null;
    if (!asked) return undefined;
    if (req.layout === 'presenter') return null;
    const layout = (req.layout ?? current?.layout) as CoverLayout | undefined;
    if (!layout) return undefined;
    const next: SceneCover = current ? { ...current, layout } : { layout, source: 'stock_video' };
    if (req.screenVideo != null) { next.source = 'own_video'; next.assetId = req.screenVideo; delete next.keywords; delete next.inS; }
    else if (req.screenSearch) { next.source = 'stock_video'; next.keywords = req.screenSearch; delete next.assetId; delete next.inS; }
    if (req.screenStartS != null && next.source === 'own_video') next.inS = req.screenStartS;
    if (!current && req.screenVideo == null && !req.screenSearch) return undefined;   // a new layout with nothing to show
    if (req.corner) next.corner = req.corner;
    if (layout === 'cover') delete next.corner;
    if (req.bubbleSize) { if (req.bubbleSize === 'small' && layout === 'bubble') next.size = 'small'; else delete next.size; }
    if (layout !== 'bubble') delete next.size;
    return next;
}
