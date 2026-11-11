// src/utils/own-voice.ts
// The owner's own voice on a Video Producer video (docs/video-producer-manual-controls-plan.md Phase 3,
// 2026-11-10): a recording of one scene's line (the default, decision D-V1), or one recording of the whole
// script. Never mixed with the AI voice in one video (D-V2).
//
// The browser converts every recording or upload to a small mono WAV before it is uploaded, so the build
// can level it like the AI voice (audio-levelling.ts reads WAV and MP3 only) and whisper takes it whole.
// Here a recording is transcribed (captions, "while its words are said", the length of the scene),
// moderated on what was said, and marked as a voiceover on its asset (render_params.kind 'voiceover' —
// what post-render.ts reads caption words from). A failed transcription keeps the recording with no
// words: captions are then absent, never invented — and the scene takes the recording's measured length.
//
// It costs nothing: no voice is made, so a video in the owner's voice holds no voiceover task.

import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';
import { presignR2Get } from './social-publish';
import { transcribeAudio, type SpokenWord } from '../lib/tts';
import { moderatePrompt } from './moderation';
import type { Scene, Storyboard } from '../lib/storyboard';

type Db = ReturnType<typeof getDb>;

/** A line is short; one recording of a whole 60 s script with room to breathe. */
export const MAX_LINE_S = 40;
export const MAX_WHOLE_S = 180;
/** whisper takes 25 MB; a 24 kHz mono WAV is ~48 KB/s, so 180 s is ~9 MB. */
const MAX_BYTES = 24 * 1024 * 1024;
/** The gap after each recorded line before the next scene starts. */
export const LINE_GAP_S = 0.35;

export interface OwnRecording { assetId: number; durationS: number; words: SpokenWord[]; differs: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * Does what was said differ a lot from the line? Share of the script's words heard, in any order.
 * A warning only — a person ad-libs, and that is their call. Pure.
 */
export function saysSomethingElse(script: string, heard: string[]): boolean {
    const want = norm(script);
    if (!want.length || !heard.length) return false;
    const got = new Set(heard.flatMap(norm));
    const hit = want.filter((w) => got.has(w)).length;
    return hit / want.length < 0.6;
}

/**
 * Read, transcribe, moderate and mark one of the owner's recordings. `script` is the line (or the whole
 * script) it is meant to say. The asset must be this workspace's audio, still stored.
 */
export async function prepareOwnRecording(db: Db, args: { orgId: number; assetId: number; script: string; maxS: number; language?: string | null }): Promise<OwnRecording | { error: string; status: number }> {
    const [a] = await db.select().from(contentAssets)
        .where(and(eq(contentAssets.id, args.assetId), eq(contentAssets.organisationId, args.orgId), eq(contentAssets.assetType, 'audio'), isNull(contentAssets.purgedAt))).limit(1);
    if (!a?.storageKey) return { error: 'That recording isn’t in your My Content.', status: 400 };
    let bytes: Buffer | null = null;
    try {
        const res = await fetch(await presignR2Get(a.storageKey, 600));
        if (res.ok) { const b = Buffer.from(await res.arrayBuffer()); if (b.byteLength > 0 && b.byteLength <= MAX_BYTES) bytes = b; }
    } catch { bytes = null; }
    if (!bytes) return { error: 'That recording couldn’t be read. Record it again, or upload a shorter file.', status: 400 };

    let words: SpokenWord[] = [];
    let heardS: number | null = null;
    try {
        const mime = (a.mimeType || 'audio/wav').split(';')[0];
        const ext = /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
        ({ words, durationS: heardS } = await transcribeAudio(bytes, { filename: `voice.${ext}`, type: mime, timeoutMs: 18_000, ...(args.language ? { language: args.language } : {}) }));
    } catch (err) {
        console.warn('[own-voice] transcription failed — keeping the recording without words:', err instanceof Error ? err.message : err);
    }
    // What was said goes through the same moderation as typed words.
    const said = words.map((w) => w.word).join(' ').trim();
    if (said) {
        const mod = await moderatePrompt(said).catch(() => ({ blocked: false, categories: [] as string[] }));
        if (mod.blocked) return { error: 'That recording can’t be used. Record the line again.', status: 400 };
    }
    const durationS = Math.round(((a.durationS && a.durationS > 0 ? a.durationS : heardS) ?? 0) * 100) / 100;
    if (!(durationS > 0)) return { error: 'That recording seems to be empty. Record it again.', status: 400 };
    if (durationS > args.maxS) return { error: `That recording is ${Math.round(durationS)} seconds — keep it under ${args.maxS}.`, status: 400 };

    const params = (a.renderParams && typeof a.renderParams === 'object' ? a.renderParams : {}) as Record<string, unknown>;
    await db.update(contentAssets).set({
        durationS,
        renderParams: { ...params, kind: 'voiceover', own: true, script: args.script.slice(0, 2000), words },
    }).where(eq(contentAssets.id, a.id));
    return { assetId: a.id, durationS, words, differs: saysSomethingElse(args.script, words.map((w) => w.word)) };
}

/** Does this video use the owner's own voice? */
export const isOwnVoice = (brief: { ownVoice?: boolean | null; voiceover?: boolean }) => brief.voiceover !== false && brief.ownVoice === true;

/** The scenes with words still to record (none when one recording covers the whole script). Pure. */
export function linesToRecord(storyboard: Storyboard, wholeRecording: boolean): Scene[] {
    if (wholeRecording) return [];
    return storyboard.scenes.filter((s) => (s.voiceover || '').trim() && !s.voiceAssetId);
}

/**
 * Recordings follow their lines: after any change to a storyboard, a scene keeps its recording only
 * while its id AND its words are the same. Ids from the model are never trusted as recordings. Pure.
 */
export function keepRecordings(before: Storyboard | null | undefined, after: Storyboard): Storyboard {
    const old = new Map((before?.scenes ?? []).map((s) => [s.id, s]));
    return {
        ...after,
        scenes: after.scenes.map((s) => {
            const { voiceAssetId: _a, voiceS: _s, ...rest } = s;
            const b = old.get(s.id);
            return b?.voiceAssetId && (b.voiceover || '') === (s.voiceover || '') ? { ...rest, voiceAssetId: b.voiceAssetId, voiceS: b.voiceS } : rest;
        }),
    };
}

/** Each scene's length when every line is recorded: the recording plus a short gap, never under the scene's floor. Pure. */
export function recordedDurations(scenes: Scene[], minS = 1.5): number[] | null {
    if (!scenes.some((s) => s.voiceAssetId)) return null;
    return scenes.map((s) => (s.voiceAssetId && s.voiceS ? Math.max(minS, Math.round((s.voiceS + LINE_GAP_S) * 10) / 10) : s.targetS));
}
