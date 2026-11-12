// netlify/functions/generate-voiceover.ts
// "Add a voiceover" — a script spoken in one of six voices, saved to the library as audio
// (Video Producer plan, Phase 2). Synchronous: speech + transcription fit inside the function's 26 s.
//
//   GET                              → { voices: [{ id, label, … }], languages, cost, maxChars }
//   POST { text, voice, name? }      → { assetId, url, name, durationS, words }
//   POST { text, voice, postId | postIds, captions?, captionStyle? }
//                                    → the same, AND the voiceover is put on that post — or on every
//                                      platform row of a cross-post, one voiceover (one task) for all —
//                                      with music turned down under it. The chat card's click
//                                      (post_action_proposal action 'voiceover').
//   POST { action: 'captions', postId, captions?, captionStyle? }  → captions on/off and their look
//   POST { action: 'align', postId } → the post's text boxes timed to its voiceover's words
// The post-level actions are src/utils/post-voiceover.ts, shared by the editor and chat. Only making
// a voiceover spends (1 task); captions and timing are free.
//
// The voiceover is an AUDIO ASSET, not a new pipeline. It is placed on a post through the existing
// audio overlays (timing, fades, mute-under), exactly as a music-library track is — the renderer knows
// nothing about where an assetId came from.
//
// The making (speech, word timings, storage) is src/utils/voiceover-asset.ts, shared with the Video
// Producer. Word timings live on content_assets.render_params = { kind: 'voiceover', voice, script,
// words }; a transcription failure keeps the audio with words: [] — captions absent, never invented.
//
// Gate: the sound capability (`ai_music_generation`) — a voiceover is sound on a post. Cost: 1
// (VOICEOVER_CREDIT_COST, owner decision 2026-10-31), held before the call, refunded on any failure.

import { getDb } from '../../db/client';
import { and, eq } from 'drizzle-orm';
import { mediaGenerationJobs, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { presignR2Get } from '../../src/utils/social-publish';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { holdCredits, settleHold, VOICEOVER_CREDIT_COST } from '../../src/utils/ai-credits';
import { r2IsConfigured } from '../../src/lib/media-persist';
import { makeVoiceoverAsset } from '../../src/utils/voiceover-asset';
import {
    OFFERED_VOICES, VOICE_LANGUAGES, DEFAULT_VOICE, VOICEOVER_MAX_CHARS, TTS_MODEL, isVoiceId, voiceConfigured, cleanScript, TtsError,
} from '../../src/lib/tts';
import { checkPostForVoiceover, attachVoiceover, setPostCaptions, timePostTextToVoice } from '../../src/utils/post-voiceover';
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
        return json(200, { voices: OFFERED_VOICES, languages: VOICE_LANGUAGES, defaultVoice: DEFAULT_VOICE, cost: VOICEOVER_CREDIT_COST, maxChars: VOICEOVER_MAX_CHARS });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { text?: string; voice?: string; name?: string; action?: string; postId?: unknown; postIds?: unknown; captions?: unknown; captionStyle?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }
    const postIds = [...new Set((Array.isArray(body.postIds) ? body.postIds : body.postId == null ? [] : [body.postId]).map(Number))].slice(0, 10);
    if (postIds.some((id) => !Number.isInteger(id) || id <= 0)) return json(400, { error: 'postId must be a post id.' });
    const postId = postIds[0] ?? null;

    // Free post-level actions: no speech, no spend.
    if (body.action === 'captions' || body.action === 'align') {
        if (postId == null) return json(400, { error: 'postId is required.' });
        const r = body.action === 'captions'
            ? await setPostCaptions(db, { orgId, postId, captions: typeof body.captions === 'boolean' ? body.captions : undefined, captionStyle: body.captionStyle })
            : await timePostTextToVoice(db, { orgId, postId });
        return 'error' in r ? json(r.status, { error: r.error }) : json(200, r);
    }
    if (body.action != null) return json(400, { error: 'Unknown action.' });

    // Either speaker's key switches voiceovers on; a voice whose own provider has no key fails and is refunded.
    if (!(process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY) || !r2IsConfigured()) {
        return json(503, { error: 'not_configured', message: 'Voiceovers are not switched on yet.' });
    }
    if (await isGlobalAiDisabled()) return json(503, { error: 'AI services are temporarily unavailable.' });

    const script = cleanScript(body.text || '');
    if (!script) return json(400, { error: 'Write what the voiceover should say first.' });
    if ((body.text || '').length > VOICEOVER_MAX_CHARS + 200) {
        return json(400, { error: `Keep it under ${VOICEOVER_MAX_CHARS} characters — about 80 seconds of speech.` });
    }
    const voice = isVoiceId(body.voice) ? body.voice : DEFAULT_VOICE;
    // No fallback voice (2026-11-12): refuse before holding a credit when this voice's own speaker has no key.
    if (!voiceConfigured(voice)) return json(503, { error: 'not_configured', message: 'That voice is not available right now. Please pick another.' });

    if (!await orgHasAssistantFeature(db, orgId, 'ai_music_generation')) {
        return featureUnavailableResponse('None of your assistants can add sound to posts.');
    }

    const blocked = await enforcePromptModeration({ text: script, userId, organisationId: orgId, source: 'generate-voiceover' });
    if (blocked) return blocked;
    // A voiceover for a post: refuse before spending if it can't go on any of them.
    for (const id of postIds) {
        const bad = await checkPostForVoiceover(db, orgId, id);
        if (bad) return json(bad.status, { error: bad.error });
    }

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

    const name = voiceoverName(body.name, script);
    let made;
    try {
        made = await makeVoiceoverAsset(db, { orgId, userId, script, voice, name });
    } catch (err) {
        const e = err instanceof TtsError ? err : null;
        await refund(err instanceof Error ? err.message : 'voiceover failed', e?.kind === 'policy' ? 'flagged' : 'failed');
        console.error('[generate-voiceover] failed:', e?.kind ?? 'save', err instanceof Error ? err.message : err);
        return json(e?.kind === 'policy' ? 422 : 502, {
            error: e?.kind === 'policy' ? 'That script could not be read aloud. Please change the wording.' : 'The voiceover could not be made. Your credit was not used.',
        });
    }
    // Made for a post: credit that post's assistant. Without one, or if the lookup fails, it stays unattributed.
    const owner = postId == null ? null : (await db.select({ assistantId: scheduledPosts.assistantId }).from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId))).limit(1).catch(() => []))[0];
    await settleHold(db, { orgId, amount: VOICEOVER_CREDIT_COST, success: true, mediaType: 'voiceover', userId, jobId: made.jobId, assistantId: owner?.assistantId ?? null });
    const url = await presignR2Get(made.storageKey).catch(() => null);
    let clip = null;
    for (const id of postIds) {
        clip = await attachVoiceover(db, { orgId, postId: id, assetId: made.assetId, name, hasWords: made.words.length > 0, captions: body.captions !== false, captionStyle: body.captionStyle });
    }
    return json(200, { assetId: made.assetId, url, name, durationS: made.durationS, words: made.words, voice, ...(clip ? { postIds, clip } : {}) });
});
