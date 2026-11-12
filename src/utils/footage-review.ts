// src/utils/footage-review.ts
//
// The Video Producer reviews the owner's own footage (docs/video-producer-footage-and-ai-plan.md §4).
//
//   prepareFootage — the browser has read a video (src/components/footage-reader.js): its measured
//                    length and size, ~40 frames, and its sound as a small WAV it put in R2. Stored
//                    once per video in footage_analyses; nothing is spent.
//   reviewProject  — background (process-video-project-background, action 'review'): each chosen
//                    video not yet analysed is transcribed and turned into a shot list, then one call
//                    reads the shot lists against the brief and suggests edits. The project waits at
//                    'reviewed' for the owner's ticks; only then is a storyboard planned (free).
//
// Money (owner decision D-F1, 2026-11-09): FOOTAGE_REVIEW_TASKS once per review that analysed a new
// video, recorded only when the review succeeds. A review of videos already analysed is free.
// Rules live in src/lib/footage.ts; this module only fetches, calls and stores.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { contentAssets, footageAnalyses, organisations, videoProjects } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { putR2Object } from '../lib/media-persist';
import { presignR2Get } from './social-publish';
import { languageLabel, transcribeAudio } from '../lib/tts';
import { logTranscriptionCost } from './ai-usage';
import { recordCompletedWork, hasTaskCapacity } from './work-metering';
import { getTaskCosts } from './task-costs';
import { recordPlatformIncident } from './platform-incident';
import {
    enforceReview, enforceShotList, parseJsonObject, reviewSystemPrompt, reviewUserPrompt, shotListSystemPrompt, transcriptText,
    MAX_FOOTAGE_BYTES, MAX_FOOTAGE_S, MAX_FRAMES, MAX_FRAME_B64,
    type FootageReview, type FootageVideo, type ShotList, type SpokenWord,
} from '../lib/footage';
import type { OwnVideo, VideoBrief } from '../lib/storyboard';

type Db = ReturnType<typeof getDb>;

/**
 * Bump when the shot-list prompt or rules change, so old analyses are redone on the next review.
 * 2 (2026-11-09): the transcription is told the language, and the browser sends loudness. A video
 * analysed before is redone FREE (reviewProject charges only for videos never analysed).
 */
export const ANALYSIS_VERSION = 3;   // 3 (2026-11-09): "um"s are transcribed (transcriptionPrompt)

/**
 * What whisper is primed with (only when it stands in for ElevenLabs Scribe, which is verbatim by
 * default and keeps the "um"s without a prompt — src/lib/tts.ts). whisper drops "um"s by default — and then tightening can't see them, and its
 * loudness safety net protects them as "unheard speech" (staging, 2026-11-09: two opening ums stayed).
 * A prompt written WITH hesitations makes it write them down (OpenAI's documented technique); English
 * only, because a hesitation prompt in the wrong language pulls the transcript towards it. Pure.
 */
export function transcriptionPrompt(language: string, businessName: string): string | undefined {
    const biz = businessName ? ` A short video for ${businessName}.` : '';
    if (language === 'en') return `Umm, so, uh, let me think, like, hmm... Okay, here's what I'm, um, thinking.${biz}`;
    return biz.trim() || undefined;
}

/** The language the owner's footage is transcribed in: the brief's, else English. Pure. */
export function footageLanguage(brief: Pick<VideoBrief, 'language'>): string {
    return typeof brief.language === 'string' && /^[a-z]{2}$/.test(brief.language) && languageLabel(brief.language) ? brief.language : 'en';
}

/** Where the browser's WAV for one video goes. Scoped by workspace and asset, checked on prepare. */
export function footageAudioPrefix(orgId: number, assetId: number): string {
    return `${orgId}/footage/${assetId}/`;
}

/** The workspace's OWN videos (uploads — never stock or AI), optionally only these ids. Newest first. */
export async function ownVideos(db: Db, orgId: number, ids?: number[]) {
    if (ids && !ids.length) return [];
    return db.select({
        id: contentAssets.id, name: contentAssets.name, durationS: contentAssets.durationS, width: contentAssets.width,
        height: contentAssets.height, fileSize: contentAssets.fileSize, storageKey: contentAssets.storageKey,
        createdAt: contentAssets.createdAt, provider: contentAssets.provider,
    })
        .from(contentAssets)
        .where(and(
            eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'video'), isNull(contentAssets.purgedAt),
            isNull(contentAssets.provider),
            ...(ids ? [inArray(contentAssets.id, ids)] : []),
        ))
        .orderBy(contentAssets.id);
}

/** The chosen videos with what is known of them — measured length first, then the upload's own. */
export async function loadFootage(db: Db, orgId: number, ids: number[]): Promise<FootageVideo[]> {
    if (!ids.length) return [];
    const [assets, analyses] = await Promise.all([
        ownVideos(db, orgId, ids),
        db.select().from(footageAnalyses).where(and(eq(footageAnalyses.organisationId, orgId), inArray(footageAnalyses.assetId, ids))),
    ]);
    const byAsset = new Map(analyses.map((a) => [a.assetId, a]));
    const byId = new Map(assets.map((a) => [a.id, a]));
    return ids.flatMap((id) => {
        const a = byId.get(id);
        if (!a) return [];
        const fa = byAsset.get(id);
        const durationS = fa?.durationS ?? a.durationS ?? 0;
        const done = fa?.status === 'done' && fa.version === ANALYSIS_VERSION;
        return [{
            id, name: a.name || `Video ${id}`, durationS,
            analysis: done ? (fa!.analysis as ShotList) : null,
            words: done ? ((fa!.words as SpokenWord[]) ?? []) : [],
        }];
    });
}

/** The chosen videos as the storyboard rules see them (measured length only). */
export function asOwnVideos(videos: FootageVideo[]): OwnVideo[] {
    return videos.filter((v) => v.durationS > 0).map((v) => ({ id: v.id, name: v.name, durationS: v.durationS }));
}

// ── Prepare (request path) ──────────────────────────────────────────────────────────────────────

export interface PrepareInput {
    assetId: number;
    durationS: number;
    width?: number | null;
    height?: number | null;
    frames: Array<{ t: number; data: string }>;
    /** The R2 key the browser PUT the WAV to, or null when the video has no sound to read. */
    audioKey: string | null;
    /** Loudness every 0.1 s (RMS × 1000), from the browser — the tightening safety net. */
    loudness?: number[];
}

/** Validate and store what the browser read. Returns a user-facing error or ok. */
export async function prepareFootage(db: Db, orgId: number, input: PrepareInput): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const [asset] = await ownVideos(db, orgId, [input.assetId]);
    if (!asset) return { ok: false, status: 404, error: 'That video isn’t one of your own uploads.' };
    if ((asset.fileSize ?? 0) > MAX_FOOTAGE_BYTES) return { ok: false, status: 413, error: 'That video is larger than 500 MB. Trim it first, or pick the part you want.' };
    const durationS = Number(input.durationS);
    if (!(durationS > 0.5)) return { ok: false, status: 422, error: 'That video couldn’t be read. Try uploading it again as an MP4.' };
    if (durationS > MAX_FOOTAGE_S + 1) return { ok: false, status: 413, error: 'That video is longer than 5 minutes. Trim it first, or pick the part you want.' };
    const frames = (Array.isArray(input.frames) ? input.frames : [])
        .filter((f) => f && Number.isFinite(Number(f.t)) && typeof f.data === 'string' && f.data.length > 100 && f.data.length <= MAX_FRAME_B64 && /^[A-Za-z0-9+/=]+$/.test(f.data))
        .slice(0, MAX_FRAMES)
        .map((f) => ({ t: Math.max(0, Math.min(durationS, Number(f.t))), data: f.data }));
    if (!frames.length) return { ok: false, status: 422, error: 'No pictures could be read from that video. Try uploading it again as an MP4.' };
    const audioKey = typeof input.audioKey === 'string' && input.audioKey ? input.audioKey : null;
    if (audioKey && (!audioKey.startsWith(footageAudioPrefix(orgId, input.assetId)) || audioKey.includes('..'))) {
        return { ok: false, status: 400, error: 'That sound file doesn’t belong to this video.' };
    }
    const loudness = (Array.isArray(input.loudness) ? input.loudness : [])
        .slice(0, Math.ceil((MAX_FOOTAGE_S + 1) / 0.1))
        .map((n) => Math.max(0, Math.min(1000, Math.round(Number(n) || 0))));
    const framesKey = `${footageAudioPrefix(orgId, input.assetId)}frames-${Date.now()}.json`;
    await putR2Object({ key: framesKey, bytes: Buffer.from(JSON.stringify({ frames, loudness })), contentType: 'application/json' });
    const w = Number(input.width), h = Number(input.height);
    const width = Number.isInteger(w) && w > 0 ? w : null;
    const height = Number.isInteger(h) && h > 0 ? h : null;
    // `analysis` is left as it was: whether a video was EVER analysed decides whether a review of it
    // is charged (reviewProject), and an old analysis is never used once the version moves on.
    const values = {
        organisationId: orgId, status: 'prepared', durationS, width, height, framesKey, frameCount: frames.length,
        audioKey, words: [], error: null, version: ANALYSIS_VERSION, updatedAt: new Date(),
    };
    await db.insert(footageAnalyses).values({ assetId: input.assetId, ...values })
        .onConflictDoUpdate({ target: footageAnalyses.assetId, set: values });
    // The upload may never have been measured (an old row); the browser just did.
    const fill: Partial<typeof contentAssets.$inferInsert> = {};
    if (asset.durationS == null) fill.durationS = durationS;
    if (asset.width == null && width) fill.width = width;
    if (asset.height == null && height) fill.height = height;
    if (Object.keys(fill).length) await db.update(contentAssets).set(fill).where(eq(contentAssets.id, input.assetId));
    return { ok: true };
}

/** Which of these videos still need the browser to read them (no frames stored, or too old to use). */
export async function footageStatus(db: Db, orgId: number, ids: number[]) {
    if (!ids.length) return [];
    const rows = await db.select({ assetId: footageAnalyses.assetId, status: footageAnalyses.status, version: footageAnalyses.version, durationS: footageAnalyses.durationS, analysis: footageAnalyses.analysis })
        .from(footageAnalyses).where(and(eq(footageAnalyses.organisationId, orgId), inArray(footageAnalyses.assetId, ids)));
    const byId = new Map(rows.map((r) => [r.assetId, r]));
    return ids.map((id) => {
        const r = byId.get(id);
        const analysed = r?.status === 'done' && r.version === ANALYSIS_VERSION;
        return {
            assetId: id,
            // A failed analysis is read again from scratch: the frames may have been the problem.
            needsReading: !r || r.status === 'failed' || r.version !== ANALYSIS_VERSION,
            analysed,
            // Reviewed under any version of the rules → reviewing it again is free (reviewProject).
            reviewedBefore: r?.analysis != null,
            durationS: r?.durationS ?? null,
            summary: analysed ? ((r!.analysis as ShotList | null)?.summary ?? null) : null,
        };
    });
}

// ── Analyse (background) ────────────────────────────────────────────────────────────────────────

async function r2Bytes(key: string): Promise<Buffer> {
    const url = await presignR2Get(key, 600);
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Stored footage could not be read (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
}

/** Transcribe and shot-list one prepared video. Throws with a message the owner can act on. */
async function analyseOne(db: Db, row: typeof footageAnalyses.$inferSelect, ctx: { orgId: number; assistantId: number | null; model: Awaited<ReturnType<typeof gatewayRoleModel>>; language: string; businessName: string }): Promise<void> {
    let words: SpokenWord[] = [];
    if (row.audioKey) {
        const wav = await r2Bytes(row.audioKey);
        if (wav.length > 25 * 1024 * 1024) throw new Error('The sound in that video is too long to read. Trim the video first.');
        const heard = await transcribeAudio(wav, {
            filename: 'footage.wav', type: 'audio/wav', timeoutMs: 90_000, language: ctx.language,
            prompt: transcriptionPrompt(ctx.language, ctx.businessName),
            keyterms: ctx.businessName ? [ctx.businessName] : [],
        });
        words = heard.words;
        await logTranscriptionCost(row.durationS, { workspaceId: ctx.orgId, assistantId: ctx.assistantId, sessionId: 'footage-review' }, heard.provider);
    }
    // Stored as { frames, loudness } since 2026-11-09; a bare array before.
    const stored = JSON.parse((await r2Bytes(row.framesKey)).toString('utf8')) as Array<{ t: number; data: string }> | { frames: Array<{ t: number; data: string }>; loudness?: number[] };
    const frames = Array.isArray(stored) ? stored : stored.frames;
    const loudness = Array.isArray(stored) ? [] : (stored.loudness ?? []);
    const content: Array<Record<string, unknown>> = [];
    for (const f of frames.slice(0, MAX_FRAMES)) {
        content.push({ type: 'text', text: `Frame at ${Number(f.t).toFixed(1)} s:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
    }
    content.push({ type: 'text', text: `The video is ${row.durationS.toFixed(1)} seconds long.\n\nWORDS SPOKEN (time in seconds in brackets):\n${transcriptText(words)}` });
    const res = await gatewayGenerate({
        system: shotListSystemPrompt(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: 'user', content: content as any }],
        maxTokens: 3000,
        deadlineMs: 180_000,
        usage: { workspaceId: ctx.orgId, assistantId: ctx.assistantId },
        ...ctx.model,
    });
    const analysis: ShotList = { ...enforceShotList(parseJsonObject(res.text), row.durationS, words), ...(loudness.length ? { loudness } : {}) };
    await db.update(footageAnalyses).set({ status: 'done', analysis, words, error: null, version: ANALYSIS_VERSION, updatedAt: new Date() })
        .where(eq(footageAnalyses.assetId, row.assetId));
}

/** brief → footage review. Only acts on a project in 'reviewing'; every exit is terminal. */
export async function reviewProject(db: Db, projectId: number): Promise<void> {
    const [p] = await db.select().from(videoProjects).where(eq(videoProjects.id, projectId)).limit(1);
    if (!p || p.status !== 'reviewing') return;
    const orgId = p.organisationId;
    const brief = p.brief as VideoBrief;
    const ids = brief.footageAssetIds ?? [];
    try {
        if (!ids.length) throw new Error('No videos were chosen.');
        const model = await gatewayRoleModel(db, 'video_producer');
        const rows = await db.select().from(footageAnalyses).where(and(eq(footageAnalyses.organisationId, orgId), inArray(footageAnalyses.assetId, ids)));
        const missing = ids.filter((id) => !rows.some((r) => r.assetId === id));
        if (missing.length) throw new Error('Some of the videos weren’t read in your browser first. Choose them again and press “Review my footage”.');
        const todo = rows.filter((r) => !(r.status === 'done' && r.version === ANALYSIS_VERSION));
        // Charged only for a video never analysed before: redoing one because our rules moved on
        // (ANALYSIS_VERSION) is our cost, not the owner's.
        const fresh = todo.filter((r) => r.analysis == null).length;
        const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const language = footageLanguage(brief);
        // Two at a time: each is a vision call of up to 40 frames plus a transcription.
        for (let i = 0; i < todo.length; i += 2) {
            await Promise.all(todo.slice(i, i + 2).map(async (row) => {
                try {
                    await analyseOne(db, row, { orgId, assistantId: p.aiAssistantId ?? null, model, language, businessName: org?.name ?? '' });
                } catch (err) {
                    const msg = err instanceof Error ? err.message.slice(0, 300) : 'It couldn’t be read.';
                    await db.update(footageAnalyses).set({ status: 'failed', error: msg, updatedAt: new Date() }).where(eq(footageAnalyses.assetId, row.assetId));
                    throw new Error(`One of your videos couldn’t be reviewed: ${msg}`);
                }
            }));
        }
        const videos = await loadFootage(db, orgId, ids);
        const res = await gatewayGenerate({
            system: reviewSystemPrompt(),
            messages: [{ role: 'user', content: reviewUserPrompt({ brief, businessName: org?.name ?? '', videos }) }],
            maxTokens: 2500,
            deadlineMs: 120_000,
            usage: { workspaceId: orgId, assistantId: p.aiAssistantId ?? null },
            ...model,
        });
        const charged = fresh ? (await getTaskCosts()).weights.footage_review : 0;
        const review: FootageReview = enforceReview(parseJsonObject(res.text), videos, charged);
        await db.update(videoProjects).set({ status: 'reviewed', footageReview: review, note: null, updatedAt: new Date() })
            .where(and(eq(videoProjects.id, projectId), eq(videoProjects.status, 'reviewing')));
        if (charged) await recordCompletedWork(db, orgId, 'footage_review', { units: charged, ref: `video-project-${projectId}`, assistantId: p.aiAssistantId ?? null });
    } catch (err) {
        console.error(`[footage-review] review ${projectId} failed:`, err);
        const msg = err instanceof Error ? err.message : '';
        if (!/^(One of your videos|Some of the videos|No videos)/.test(msg)) {
            await recordPlatformIncident(db, { kind: 'video_footage_review', error: err, organisationId: orgId, assistantId: p.aiAssistantId, role: 'video_producer', view: 'video-producer', ids: { projectId } });
        }
        await db.update(videoProjects).set({
            status: 'failed', note: msg.slice(0, 400) || 'The footage couldn’t be reviewed. Nothing was charged — try again.', updatedAt: new Date(),
        }).where(eq(videoProjects.id, projectId));
    }
}

/** Can this workspace pay for a review of these videos? Free when all are analysed already. */
export async function canAffordReview(db: Db, orgId: number, ids: number[]): Promise<boolean> {
    const status = await footageStatus(db, orgId, ids);
    if (status.every((s) => s.reviewedBefore)) return true;
    return hasTaskCapacity(db, orgId, (await getTaskCosts()).weights.footage_review);
}
