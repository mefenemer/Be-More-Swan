// src/lib/stability-audio.ts
// Stability AI — Stable Audio 3.0 text-to-music, called direct (not through fal).
//
// Direct rather than through the fal gateway the image and video paths use, for two reasons the
// user chose it for: the licence is then with the company that owns the model (the Community
// License, and the Enterprise License with indemnity above $1M revenue), and a fal balance running
// dry — which took AI images down on 2026-09-28 — no longer takes music with it.
//
// ⚠️ Stable Audio 3.0, not 2.5. The 2.x endpoint is SYNCHRONOUS: the request holds open until the
// track exists, and a Netlify function would have to sit inside that wait. 3.0's endpoint returns a
// generation id immediately (HTTP 202) and is polled at /results/{id} — the same submit-then-poll
// shape the video worker already has. From Stability's OpenAPI (api.stability.ai/v2alpha/openapi),
// read 2026-10-04:
//
//   POST /v2beta/audio/stable-audio/text-to-audio   multipart: prompt, model, duration (1–380 s),
//        seed, steps (4–8), cfg_scale, output_format (mp3|wav)        → 202 { id }
//        26 credits per SUCCESSFUL generation; failures are not charged.
//   GET  /v2beta/audio/results/{id}   accept: audio/*                → 202 in progress | 200 bytes
//        404 = no such generation, or it has EXPIRED — so poll promptly and keep the bytes.
//   403 = flagged by Stability's content moderation. 429 = over 150 requests in 10 seconds.

const BASE = 'https://api.stability.ai/v2beta/audio';

/** The model is configuration, so a newer one is a setting rather than a release. */
export const MUSIC_MODEL = process.env.STABILITY_AUDIO_MODEL || 'stable-audio-3';

/** Stability's own bounds for 3.0. Callers clamp to OUR bounds first (src/lib/music-prompt.ts). */
export const STABILITY_MAX_DURATION_S = 380;

export function stabilityConfigured(): boolean {
    return !!process.env.STABILITY_API_KEY;
}

/** Stability's content moderation refused the prompt. Not retryable — the words have to change. */
export class StabilityPolicyError extends Error {}

/** Anything else: bad request, rate limit, outage, expired result. */
export class StabilityError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

function headers(accept: string): Record<string, string> {
    return {
        authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
        accept,
        // Optional identification headers Stability asks integrators to send.
        'stability-client-id': 'be-more-swan',
    };
}

/** Stability errors carry `{ name, errors: [..] }`. Fall back to the status if the body is not JSON. */
async function errorText(res: Response): Promise<string> {
    try {
        const j = await res.json() as { errors?: unknown; message?: unknown; name?: unknown };
        if (Array.isArray(j.errors) && j.errors.length) return j.errors.map(String).join('; ');
        if (j.message) return String(j.message);
        if (j.name) return String(j.name);
    } catch { /* not JSON */ }
    return `Stability returned HTTP ${res.status}`;
}

/** Start a generation. Returns Stability's id for it; nothing is charged until it succeeds. */
export async function submitMusic(params: { prompt: string; durationS: number; seed?: number }): Promise<{ id: string }> {
    const form = new FormData();
    form.append('prompt', params.prompt);
    form.append('model', MUSIC_MODEL);
    form.append('duration', String(params.durationS));
    form.append('output_format', 'mp3');
    if (params.seed) form.append('seed', String(params.seed));

    const res = await fetch(`${BASE}/stable-audio/text-to-audio`, {
        method: 'POST', headers: headers('application/json'), body: form,
    });
    if (res.status === 403) throw new StabilityPolicyError(await errorText(res));
    if (res.status !== 202 && res.status !== 200) throw new StabilityError(await errorText(res), res.status);
    const j = await res.json().catch(() => ({})) as { id?: unknown };
    if (typeof j.id !== 'string' || !j.id) throw new StabilityError('Stability did not return a generation id.', res.status);
    return { id: j.id };
}

export type MusicResult =
    | { done: false }
    | { done: true; bytes: Buffer; contentType: string; seed: string | null };

/** One poll. `done:false` while Stability is still working on it. */
export async function fetchMusicResult(id: string): Promise<MusicResult> {
    const res = await fetch(`${BASE}/results/${encodeURIComponent(id)}`, { headers: headers('audio/*') });
    if (res.status === 202) return { done: false };
    if (res.status === 403) throw new StabilityPolicyError(await errorText(res));
    if (res.status !== 200) throw new StabilityError(await errorText(res), res.status);
    const contentType = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.byteLength) throw new StabilityError('Stability returned an empty track.', 200);
    return { done: true, bytes, contentType, seed: res.headers.get('seed') };
}
