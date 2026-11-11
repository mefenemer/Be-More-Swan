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

export const VIDEO_SCENE_EDIT_TYPE = 'video_scene_edit';

/** product_photo needs a picture of theirs, which a card can't choose. */
const CARD_SOURCES = ['stock_video', 'stock_photo', 'ai_video', 'ai_image', 'brand_card'] as const;
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
}
export interface VideoSceneCard {
    type: typeof VIDEO_SCENE_EDIT_TYPE; projectId: number; scene: number; sceneId: string; summary: string | null;
    /** What edit_scene is sent. */
    patch: { voiceover?: string; onScreenText?: string; source?: CardSource; keywords?: string; prompt?: string; nameCaption?: NameCaption | null; cutPhrase?: string } & SceneTextFields;
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
    return req.voiceover != null || req.onScreenText != null || req.source != null || req.picture != null || req.nameCaption !== undefined || req.text || req.cutPhrase ? req : null;
}

/** The card for this scene of this storyboard. Null when there is no such scene, or nothing would change. */
export function videoSceneCard(req: VideoSceneRequest, storyboard: Storyboard | null | undefined): VideoSceneCard | null {
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
