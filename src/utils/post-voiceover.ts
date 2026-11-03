// src/utils/post-voiceover.ts
// A voiceover ON A POST: attach one, change its captions, and time the post's text to it.
//
// One implementation for the post editor (workspace.html, through generate-voiceover.ts) and for chat
// (the `voiceover_proposal` card, whose click calls the same endpoint) — so the two can never put a
// voiceover on a post differently ([[assistant-gui-chat-parity]]). The making of the audio itself is
// src/utils/voiceover-asset.ts; spending and refunds stay in generate-voiceover.ts.
//
// Every read and write is org-scoped. Audio lives on the post only (like save-post-audio.ts), and the
// timed text is written to the same post only — a cross-posted copy keeps its own design.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { scheduledPosts, contentAssets } from '../../db/schema';
import { sanitiseAudioOverlays, renderableAudio, MAX_AUDIO_OVERLAYS, type AudioOverlay } from '../lib/audio-overlays';
import { alignTextToWords, normalizeCaptionStyle, type SpokenWordLike } from '../lib/captions';

type Db = ReturnType<typeof getDb>;

/** Music already at full volume is turned down to this under a new voice (the editor does the same). */
export const VOICE_DUCK = 0.35;

/** Statuses whose design can no longer change: out, going out, or withdrawn. */
const FINAL = ['published', 'publishing', 'cancelled'];

async function loadPost(db: Db, orgId: number, postId: number) {
    const [post] = await db.select({
        id: scheduledPosts.id, status: scheduledPosts.status,
        audioOverlays: scheduledPosts.audioOverlays, imageOverlays: scheduledPosts.imageOverlays,
    }).from(scheduledPosts).where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId))).limit(1);
    return post ?? null;
}

export type PostVoiceError = { error: string; status: number };

/** Can a voiceover go on this post? Checked BEFORE anything is spent. */
export async function checkPostForVoiceover(db: Db, orgId: number, postId: number): Promise<PostVoiceError | null> {
    const post = await loadPost(db, orgId, postId);
    if (!post) return { error: 'Post not found.', status: 404 };
    if (FINAL.includes(String(post.status))) return { error: 'That post has already gone out, so it can no longer change.', status: 409 };
    if (renderableAudio(post.audioOverlays).length >= MAX_AUDIO_OVERLAYS) return { error: `That post already carries the most sound it can (${MAX_AUDIO_OVERLAYS} clips).`, status: 409 };
    return null;
}

/** Put a made voiceover on a post, captions on when it has words, music turned down under it. */
export async function attachVoiceover(db: Db, args: {
    orgId: number; postId: number; assetId: number; name: string; hasWords: boolean;
    captions?: boolean; captionStyle?: unknown;
}): Promise<AudioOverlay> {
    const post = await loadPost(db, args.orgId, args.postId);
    const audio = sanitiseAudioOverlays(post?.audioOverlays ?? []) ?? [];
    for (const a of audio) if (a.volume >= 1) a.volume = VOICE_DUCK;
    const clip: AudioOverlay = {
        id: `a${args.assetId}_${Date.now().toString(36)}`, assetId: args.assetId,
        label: args.name.slice(0, 120), volume: 1, fadeInS: 0.05, fadeOutS: 0.2,
        ...(args.hasWords ? { captions: args.captions !== false } : {}),
        ...(args.hasWords && args.captionStyle && typeof args.captionStyle === 'object' ? { captionStyle: normalizeCaptionStyle(args.captionStyle) } : {}),
    };
    audio.push(clip);
    await db.update(scheduledPosts).set({ audioOverlays: audio, updatedAt: new Date() })
        .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId)));
    return clip;
}

/** The voiceover clips on a post (audio assets that carry spoken words), in timeline order. */
async function voiceClips(db: Db, orgId: number, audio: AudioOverlay[]) {
    const ids = [...new Set(audio.map((a) => a.assetId))];
    if (!ids.length) return [];
    const rows = await db.select({ id: contentAssets.id, renderParams: contentAssets.renderParams }).from(contentAssets)
        .where(and(inArray(contentAssets.id, ids), eq(contentAssets.organisationId, orgId)));
    const words = new Map<number, SpokenWordLike[]>();
    for (const r of rows) {
        const p = r.renderParams as { kind?: unknown; words?: unknown } | null;
        if (p?.kind === 'voiceover' && Array.isArray(p.words)) words.set(r.id, p.words as SpokenWordLike[]);
    }
    return audio.filter((a) => words.has(a.assetId))
        .map((a) => ({ clip: a, words: words.get(a.assetId)! }))
        .sort((x, y) => (x.clip.startS ?? 0) - (y.clip.startS ?? 0));
}

/** Captions on/off and their look, on every voiceover of the post. */
export async function setPostCaptions(db: Db, args: { orgId: number; postId: number; captions?: boolean; captionStyle?: unknown }): Promise<{ changed: number } | PostVoiceError> {
    const post = await loadPost(db, args.orgId, args.postId);
    if (!post) return { error: 'Post not found.', status: 404 };
    if (FINAL.includes(String(post.status))) return { error: 'That post has already gone out, so it can no longer change.', status: 409 };
    const audio = sanitiseAudioOverlays(post.audioOverlays ?? []) ?? [];
    const voices = await voiceClips(db, args.orgId, audio);
    if (!voices.length) return { error: 'That post has no voiceover to caption. Add one first.', status: 409 };
    for (const { clip } of voices) {
        if (typeof args.captions === 'boolean') clip.captions = args.captions;
        else if (typeof clip.captions !== 'boolean') clip.captions = true;
        if (args.captionStyle && typeof args.captionStyle === 'object') clip.captionStyle = normalizeCaptionStyle({ ...(clip.captionStyle ?? {}), ...(args.captionStyle as object) });
    }
    await db.update(scheduledPosts).set({ audioOverlays: audio, updatedAt: new Date() })
        .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId)));
    return { changed: voices.length };
}

/**
 * Time the post's text boxes to its (first) voiceover: each box shows while its words are spoken
 * (captions.ts alignTextToWords). Boxes whose words are never said keep their timing.
 */
export async function timePostTextToVoice(db: Db, args: { orgId: number; postId: number }): Promise<{
    timings: Record<string, { startS: number; endS: number }>; unmatched: string[]; total: number;
} | PostVoiceError> {
    const post = await loadPost(db, args.orgId, args.postId);
    if (!post) return { error: 'Post not found.', status: 404 };
    if (FINAL.includes(String(post.status))) return { error: 'That post has already gone out, so it can no longer change.', status: 409 };
    const audio = sanitiseAudioOverlays(post.audioOverlays ?? []) ?? [];
    const [voice] = await voiceClips(db, args.orgId, audio);
    if (!voice) return { error: 'That post has no voiceover to time the text to. Add one first.', status: 409 };
    const boxes = (Array.isArray(post.imageOverlays) ? post.imageOverlays : []) as Array<Record<string, unknown>>;
    const texts = boxes.filter((b) => b && typeof b.id === 'string' && String(b.text || '').trim())
        .map((b) => ({ id: String(b.id), text: String(b.text), startS: typeof b.startS === 'number' ? b.startS : null }));
    if (!texts.length) return { error: 'That post has no text on it to time. Add some text first.', status: 409 };
    const { timings, unmatched } = alignTextToWords(texts, voice.words, voice.clip.startS ?? 0);
    if (Object.keys(timings).length) {
        const next = boxes.map((b) => (b && typeof b.id === 'string' && timings[b.id] ? { ...b, ...timings[b.id] } : b));
        await db.update(scheduledPosts).set({ imageOverlays: next, updatedAt: new Date() })
            .where(and(eq(scheduledPosts.id, args.postId), eq(scheduledPosts.organisationId, args.orgId)));
    }
    return { timings, unmatched, total: texts.length };
}
