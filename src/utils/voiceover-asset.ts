// src/utils/voiceover-asset.ts
// Speak a script, time its words, store it as an audio asset — the one implementation shared by the
// post editor's "Add a voiceover" (generate-voiceover.ts) and the Video Producer's build
// (video-producer.ts). Credits, moderation and refunds stay with each caller: they differ (one
// voiceover vs one step of a larger build), the making does not.
//
// A transcription failure keeps the audio and stores words: [] — captions are then absent, never
// invented. Throws TtsError when speech itself fails.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { mediaGenerationJobs, contentAssets } from '../../db/schema';
import { persistBufferToR2 } from '../lib/media-persist';
import { logAiUsage } from './ai-usage';
import { VOICEOVER_CREDIT_COST } from './ai-credits';
import { TTS_MODEL, synthesizeSpeech, transcribeWords, voiceoverCostUsd, type SpokenWord, type VoiceId } from '../lib/tts';

type Db = ReturnType<typeof getDb>;

export interface VoiceoverAsset {
    assetId: number;
    jobId: number;
    storageKey: string;
    durationS: number | null;
    words: SpokenWord[];
}

export async function makeVoiceoverAsset(db: Db, args: {
    orgId: number; userId: number; script: string; voice: VoiceId; name: string; assistantId?: number | null;
}): Promise<VoiceoverAsset> {
    const mp3 = await synthesizeSpeech(args.script, args.voice);
    let words: SpokenWord[] = [];
    let durationS: number | null = null;
    try {
        ({ words, durationS } = await transcribeWords(mp3));
    } catch (err) {
        console.warn('[voiceover-asset] transcription failed — saving without word timings:', err instanceof Error ? err.message : err);
    }
    const stored = await persistBufferToR2({ orgId: args.orgId, bytes: mp3, contentType: 'audio/mpeg', folder: 'voiceovers' });
    // media_type 'audio' + aspect 'none', as music — the table's CHECKs already allow both.
    const [job] = await db.insert(mediaGenerationJobs).values({
        organisationId: args.orgId, userId: args.userId, assistantId: args.assistantId ?? null, mediaType: 'audio',
        prompt: args.script.slice(0, 1000), aspectRatio: 'none', model: TTS_MODEL, creditCost: VOICEOVER_CREDIT_COST, status: 'completed',
    }).returning({ id: mediaGenerationJobs.id });
    const [asset] = await db.insert(contentAssets).values({
        userId: args.userId, organisationId: args.orgId, name: args.name,
        assetType: 'audio', mimeType: 'audio/mpeg',
        fileSize: stored.fileSize, storageKey: stored.storageKey,
        durationS, provider: 'openai', prompt: args.script,
        renderParams: { kind: 'voiceover', voice: args.voice, script: args.script, words },
        generationJobId: job.id, status: 'pending',
    }).returning({ id: contentAssets.id });
    await db.update(mediaGenerationJobs).set({ resultAssetIds: [asset.id], updatedAt: new Date() })
        .where(eq(mediaGenerationJobs.id, job.id)).catch(() => {});
    void logAiUsage({ workspaceId: args.orgId, userId: args.userId, assistantId: args.assistantId ?? null, model: TTS_MODEL, inputTokens: 0, outputTokens: 0, costUsdOverride: voiceoverCostUsd(durationS), sessionId: 'voiceover' });
    return { assetId: asset.id, jobId: job.id, storageKey: stored.storageKey, durationS, words };
}
