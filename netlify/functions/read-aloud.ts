// netlify/functions/read-aloud.ts — "Read aloud" on the assistant profile's Voice builder.
//
// The owner, 2026-11-02: the browser's own speech "plays a robotic sounding man — not human like at
// all". This reads a writing sample in a real voice the owner picks (src/public/voice-catalogue.json,
// chosen in voice-picker.js), through the same speech path as voiceovers (tts.ts speakVoiceover:
// ElevenLabs, OpenAI if it fails).
//
//   POST { text, voice } → { audio: base64 mp3, mimeType, cached }
//
// Free to the customer — it is a preview, like listening in the picker — so it is bounded instead:
//   · the same text in the same voice is spoken once, ever: cached in tour_narration_cache (the tour's
//     speech cache, a generic text-hash → audio table) under a "readaloud:" key, so no SQL;
//   · at most READS_PER_DAY fresh readings per workspace a day (cached replays don't count), counted
//     from that cache's own rows (voice column = "readaloud:<orgId>:<voiceId>");
//   · at most MAX_CHARS characters (a Voice builder sample is under 90 words).

import { createHash } from 'crypto';
import { and, eq, gte, like, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { tourNarrationCache } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { speakVoiceover, isVoiceId, cleanScript, DEFAULT_VOICE } from '../../src/lib/tts';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_CHARS = 700;
export const READS_PER_DAY = 40;

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** The cache key for a reading. Pure. */
export function readAloudHash(voice: string, text: string): string {
    return createHash('sha256').update(`readaloud:${voice}:${text}`).digest('hex');
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: { text?: unknown; voice?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
    const text = cleanScript(typeof body.text === 'string' ? body.text : '').slice(0, MAX_CHARS);
    if (!text) return json(400, { error: 'There is nothing to read.' });
    const voice = isVoiceId(body.voice) ? String(body.voice) : DEFAULT_VOICE;

    const textHash = readAloudHash(voice, text);
    const [cached] = await db.select({ audio: tourNarrationCache.audioBase64, mimeType: tourNarrationCache.mimeType })
        .from(tourNarrationCache).where(eq(tourNarrationCache.textHash, textHash)).limit(1);
    if (cached) return json(200, { audio: cached.audio, mimeType: cached.mimeType, cached: true });

    if (await isGlobalAiDisabled()) return json(503, { error: 'Reading aloud is unavailable right now.' });
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tourNarrationCache)
        .where(and(like(tourNarrationCache.voice, `readaloud:${orgId}:%`), gte(tourNarrationCache.createdAt, since)));
    if (n >= READS_PER_DAY) return json(429, { error: 'That’s the most new readings for today — the ones you’ve already heard still play. Try again tomorrow.' });

    try {
        const { mp3 } = await speakVoiceover(text, voice);
        const audio = mp3.toString('base64');
        await db.insert(tourNarrationCache).values({ textHash, voice: `readaloud:${orgId}:${voice}`, audioBase64: audio, mimeType: 'audio/mpeg' })
            .onConflictDoNothing();
        return json(200, { audio, mimeType: 'audio/mpeg', cached: false });
    } catch (err) {
        console.error('[read-aloud] failed:', err instanceof Error ? err.message : err);
        return json(502, { error: 'It couldn’t be read aloud just now. Please try again.' });
    }
});
