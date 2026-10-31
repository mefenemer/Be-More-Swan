// netlify/functions/generate-voiceover.ts
// "Add a voiceover" — a script spoken in one of six voices, saved to the library as audio
// (Video Producer plan, Phase 2). Synchronous: speech + transcription fit inside the function's 26 s.
//
//   GET                              → { voices: [{ id, label }], cost, maxChars }
//   POST { text, voice, name? }      → { assetId, url, name, durationS, words }
//
// The voiceover is an AUDIO ASSET, not a new pipeline. It is placed on a post through the existing
// audio overlays (timing, fades, mute-under), exactly as a music-library track is — the renderer knows
// nothing about where an assetId came from.
//
// Word timings (for captions, Phase 3) live on content_assets.render_params as
// { kind: 'voiceover', voice, script, words } — no new column, so nothing reads a column before its
// migration (a bare db.select() would break every read of the table until it was applied). A transcription failure keeps the audio and
// stores words: [] — captions are then absent, never invented.
//
// Gate: the sound capability (`ai_music_generation`) — a voiceover is sound on a post. Cost: 1
// (VOICEOVER_CREDIT_COST, owner decision 2026-10-31), held before the call, refunded on any failure.

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mediaGenerationJobs, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { presignR2Get } from '../../src/utils/social-publish';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { holdCredits, settleHold, VOICEOVER_CREDIT_COST } from '../../src/utils/ai-credits';
import { logAiUsage } from '../../src/utils/ai-usage';
import { persistBufferToR2, r2IsConfigured } from '../../src/lib/media-persist';
import {
    VOICES, DEFAULT_VOICE, VOICEOVER_MAX_CHARS, TTS_MODEL, isVoiceId, cleanScript,
    synthesizeSpeech, transcribeWords, voiceoverCostUsd, TtsError, type SpokenWord,
} from '../../src/lib/tts';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** "Voiceover · first few words" — what the library and the timeline row show. Pure. */
export function voiceoverName(given: unknown, script: string): string {
    const own = typeof given === 'string' ? given.trim().slice(0, 80) : '';
    if (own) return own;
    const words = script.split(' ').slice(0, 6).join(' ');
    return `Voiceover · ${words}${script.split(' ').length > 6 ? '…' : ''}`.slice(0, 80);
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    if (event.httpMethod === 'GET') {
        return json(200, { voices: VOICES, defaultVoice: DEFAULT_VOICE, cost: VOICEOVER_CREDIT_COST, maxChars: VOICEOVER_MAX_CHARS });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!process.env.OPENAI_API_KEY || !r2IsConfigured()) {
        return json(503, { error: 'not_configured', message: 'Voiceovers are not switched on yet.' });
    }
    if (await isGlobalAiDisabled()) return json(503, { error: 'AI services are temporarily unavailable.' });

    let body: { text?: string; voice?: string; name?: string };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const script = cleanScript(body.text || '');
    if (!script) return json(400, { error: 'Write what the voiceover should say first.' });
    if ((body.text || '').length > VOICEOVER_MAX_CHARS + 200) {
        return json(400, { error: `Keep it under ${VOICEOVER_MAX_CHARS} characters — about 80 seconds of speech.` });
    }
    const voice = isVoiceId(body.voice) ? body.voice : DEFAULT_VOICE;

    if (!await orgHasAssistantFeature(db, orgId, 'ai_music_generation')) {
        return featureUnavailableResponse('None of your assistants can add sound to posts.');
    }

    const blocked = await enforcePromptModeration({ text: script, userId, organisationId: orgId, source: 'generate-voiceover' });
    if (blocked) return blocked;

    const hold = await holdCredits(db, { orgId, amount: VOICEOVER_CREDIT_COST, mediaType: 'voiceover' });
    if (!hold.ok) return json(402, { error: 'insufficient_credits', cost: hold.cost, balance: hold.balance, unit: hold.unit });

    // A job row for every attempt, so the platform-wide media failure alert sees voiceovers too.
    // media_type 'audio' + aspect 'none', as music — the table's CHECKs already allow both.
    const jobBase = {
        organisationId: orgId, userId, mediaType: 'audio', prompt: script.slice(0, 1000),
        aspectRatio: 'none', model: TTS_MODEL, creditCost: VOICEOVER_CREDIT_COST,
    };
    const refund = async (message: string, status: 'failed' | 'flagged') => {
        await settleHold(db, { orgId, amount: VOICEOVER_CREDIT_COST, success: false, mediaType: 'voiceover', userId });
        await db.insert(mediaGenerationJobs).values({ ...jobBase, status, errorMessage: `[voiceover] ${message}`.slice(0, 1000) }).catch(() => {});
    };

    let mp3: Buffer;
    try {
        mp3 = await synthesizeSpeech(script, voice);
    } catch (err) {
        const e = err instanceof TtsError ? err : new TtsError(err instanceof Error ? err.message : 'speech failed');
        await refund(e.message, e.kind === 'policy' ? 'flagged' : 'failed');
        console.error('[generate-voiceover] speech failed:', e.kind, e.message);
        return json(e.kind === 'policy' ? 422 : 502, {
            error: e.kind === 'policy' ? 'That script could not be read aloud. Please change the wording.' : 'The voiceover could not be made. Your credit was not used.',
        });
    }

    // Timings are a bonus, never a reason to lose the audio the customer paid for.
    let words: SpokenWord[] = [];
    let durationS: number | null = null;
    try {
        ({ words, durationS } = await transcribeWords(mp3));
    } catch (err) {
        console.warn('[generate-voiceover] transcription failed — saving without word timings:', err instanceof Error ? err.message : err);
    }

    try {
        const stored = await persistBufferToR2({ orgId, bytes: mp3, contentType: 'audio/mpeg', folder: 'voiceovers' });
        const name = voiceoverName(body.name, script);
        const [job] = await db.insert(mediaGenerationJobs).values({ ...jobBase, status: 'completed' })
            .returning({ id: mediaGenerationJobs.id });
        const [asset] = await db.insert(contentAssets).values({
            userId, organisationId: orgId, name,
            assetType: 'audio', mimeType: 'audio/mpeg',
            fileSize: stored.fileSize, storageKey: stored.storageKey,
            durationS, provider: 'openai', prompt: script,
            renderParams: { kind: 'voiceover', voice, script, words },
            generationJobId: job.id, status: 'pending',
        }).returning({ id: contentAssets.id });
        await db.update(mediaGenerationJobs).set({ resultAssetIds: [asset.id], updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, job.id)).catch(() => {});
        await settleHold(db, { orgId, amount: VOICEOVER_CREDIT_COST, success: true, mediaType: 'voiceover', userId, jobId: job.id });
        void logAiUsage({ workspaceId: orgId, userId, model: TTS_MODEL, inputTokens: 0, outputTokens: 0, costUsdOverride: voiceoverCostUsd(durationS), sessionId: 'voiceover' });

        const url = await presignR2Get(stored.storageKey).catch(() => null);
        return json(200, { assetId: asset.id, url, name, durationS, words, voice });
    } catch (err) {
        await refund(err instanceof Error ? err.message : 'save failed', 'failed');
        console.error('[generate-voiceover] save failed:', err);
        return json(500, { error: 'The voiceover could not be saved. Your credit was not used.' });
    }
});
