// netlify/functions/tour-narration.ts — Issue #161: real neural voice for the guided tour.
//
// The tour previously relied solely on the browser's free SpeechSynthesis API, which sounds
// robotic on most systems no matter how pitch/rate are tuned. This endpoint speaks the step's
// narration with the ElevenLabs Pepper voice (the voiceover default) and returns it as base64 audio
// for tour.js to play. It was OpenAI gpt-4o-mini-tts ("shimmer") until 2026-11-12: that model shuts
// down on 6 Jan 2027 (docs/openai-audio-retirement-plan.md). The new voice is part of the cache key,
// so each step is spoken once more in Pepper and cached again.
//
// TOUR_STEPS copy is static platform content, not user data, so each distinct (text, voice) pair
// is generated once and cached forever in tour_narration_cache — after the first user hears a
// given step, every later tour run for every org serves the cached clip with no further API cost.
//
// Auth-gated (any signed-in user) purely to keep the endpoint from being an open API-cost sink;
// narration is identical for every tenant, so no tenant-scoping is needed beyond "logged in".
//
// POST { text }  →  { audio: base64 string, mimeType }
// No ELEVENLABS_API_KEY configured, or the ElevenLabs call fails → 503, and tour.js falls back to the
// browser's built-in SpeechSynthesis voice.

import { HandlerEvent } from '@netlify/functions';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { tourNarrationCache } from '../../db/schema';
import { requireSession } from '../../src/utils/session';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';
import { logAiUsage } from '../../src/utils/ai-usage';
import { DEFAULT_VOICE, ELEVENLABS_MODEL, elevenLabsVoice, elevenLabsSpeechCostUsd, synthesizeElevenLabs } from '../../src/lib/tts';

// Pepper, the British woman the owner picked by ear for voiceovers (2026-11-02).
const VOICE = DEFAULT_VOICE;
const MAX_TEXT_LEN = 2000;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const session = requireSession(event);
    if ('error' in session) return session.error;

    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable.' }) };
    }

    const elevenVoice = elevenLabsVoice(VOICE);
    if (!process.env.ELEVENLABS_API_KEY || !elevenVoice) {
        return { statusCode: 503, body: JSON.stringify({ error: 'Voice narration is not configured.' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_LEN) : '';
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: 'text is required.' }) };

    const textHash = createHash('sha256').update(`${VOICE}:${text}`).digest('hex');
    const db = getDb();

    const [cached] = await db
        .select({ audioBase64: tourNarrationCache.audioBase64, mimeType: tourNarrationCache.mimeType })
        .from(tourNarrationCache)
        .where(eq(tourNarrationCache.textHash, textHash))
        .limit(1);
    if (cached) {
        return { statusCode: 200, body: JSON.stringify({ audio: cached.audioBase64, mimeType: cached.mimeType }) };
    }

    try {
        const audioBuffer = await synthesizeElevenLabs(text, elevenVoice);
        // A cache miss is the only time this costs anything; every later run serves the stored clip.
        await logAiUsage({ model: ELEVENLABS_MODEL, inputTokens: 0, outputTokens: 0, costUsdOverride: elevenLabsSpeechCostUsd(text.length), sessionId: 'tour-narration' });
        const audioBase64 = audioBuffer.toString('base64');
        const mimeType = 'audio/mpeg';

        await db.insert(tourNarrationCache)
            .values({ textHash, voice: VOICE, audioBase64, mimeType })
            .onConflictDoNothing();

        return { statusCode: 200, body: JSON.stringify({ audio: audioBase64, mimeType }) };
    } catch (err) {
        console.error('[tour-narration] Failed to synthesize narration:', err);
        return { statusCode: 503, body: JSON.stringify({ error: 'Voice narration is temporarily unavailable.' }) };
    }
});
