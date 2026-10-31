// src/lib/fal-gateway.ts
// Centralized Fal.ai gateway for native AI media generation (Epic 1).
// Mirrors the env-config philosophy of ai-gateway.ts: swapping the target model is an
// env-var change, never a code change.
//
// Transport: Fal's queue API (https://docs.fal.ai/model-endpoints/queue).
//   submit()  POST https://queue.fal.run/{model}            → { request_id, status_url, response_url }
//   status()  GET  {status_url}                              → { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   result()  GET  {response_url}                            → model output payload
//   runSync() submit + poll until COMPLETED (bounded)        — for fast jobs (images)
//
// Config:
//   FAL_KEY               — API key (required; gateway is mock/disabled without it)
//   FAL_IMAGE_MODEL       — defaults to 'fal-ai/flux-pro/v1.1'      (FLUX 1.1 Pro, 1 credit)
//   FAL_VIDEO_MODEL       — defaults to 'fal-ai/minimax/hailuo-2.3/standard/text-to-video'
//                           (Hailuo 2.3 Standard, 768p, 5 credits). NOTE: the bare
//                           'fal-ai/minimax/hailuo-2.3' is NOT a routable endpoint — it 404s on
//                           poll ("Path /hailuo-2.3 not found"); the variant suffix is required.
//   FAL_I2V_MODEL         — image-to-video, defaults to 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video'
//                           (Kling, $0.07/s on fal's pricing page 2026-10-31). The clip is framed by
//                           its start image, so a 9:16 FLUX frame gives a 9:16 clip — the thing Hailuo
//                           text-to-video can never do. Set to 'off' to fall back to FAL_VIDEO_MODEL.
//                           Kling v3 ('fal-ai/kling-video/v3/pro/image-to-video', $0.14/s) also works.
//   FAL_SAFETY_TOLERANCE  — FLUX safety level 1 (strictest) … 6 (most permissive); default 2
//   FAL_OUTPUT_FORMAT     — 'png' (default, lossless — best for crisp text overlays) or 'jpeg'

const FAL_KEY     = process.env.FAL_KEY;
import { logMediaCost } from '../utils/ai-usage';

import { NO_TEXT_RULE } from './image-prompt';
const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';
export const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL ?? 'fal-ai/minimax/hailuo-2.3/standard/text-to-video';
export const I2V_MODEL = process.env.FAL_I2V_MODEL ?? 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';

// FLUX 1.1 Pro safety_tolerance: 1 (strictest) … 6 (most permissive). We run our own prompt
// moderation upstream, so the model-level gate is a backstop — keep Fal's default of 2.
const SAFETY_TOLERANCE = process.env.FAL_SAFETY_TOLERANCE ?? '2';
// 'png' keeps text overlays crisp (lossless); 'jpeg' is smaller. Default to png.
const OUTPUT_FORMAT    = process.env.FAL_OUTPUT_FORMAT ?? 'png';

const QUEUE_BASE = 'https://queue.fal.run';

// ── Types ────────────────────────────────────────────────────────────────────

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:5';
export const ASPECT_RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16', '4:5'];

export type FalJobStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

export interface FalSubmitResult {
    requestId: string;
    statusUrl: string;
    responseUrl: string;
}

export interface GeneratedImage {
    url: string;
    width: number | null;
    height: number | null;
    contentType: string;   // e.g. 'image/png'
}

export interface GeneratedVideo {
    url: string;
    contentType: string;   // e.g. 'video/mp4'
}

/** Thrown when Fal rejects a prompt for safety / content-policy reasons (AC: US1/US2 error handling). */
export class FalContentPolicyError extends Error {
    constructor(message = 'Prompt flagged for policy violation.') {
        super(message);
        this.name = 'FalContentPolicyError';
    }
}

/** Thrown for any other Fal transport/model error. */
export class FalError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'FalError';
    }
}

/**
 * Thrown when Fal itself is unavailable to us for account/billing reasons — an exhausted
 * balance, a locked account, or rate-limit throttling. Distinct from FalError because
 * RETRYING WON'T HELP: it needs an operator to top up / unlock the Fal account. Subclasses
 * FalError so existing `instanceof FalError` handlers still catch it, but lets callers show a
 * "temporarily unavailable" message and alert loudly instead of a generic "try again". */
export class FalServiceError extends FalError {
    constructor(message: string, status?: number) {
        super(message, status);
        this.name = 'FalServiceError';
    }
}

/** True when FAL_KEY is absent — callers can short-circuit to mock behaviour in dev. */
export function falConfigured(): boolean {
    return !!FAL_KEY;
}

// ── Aspect-ratio mapping ───────────────────────────────────────────────────────

// FLUX 1.1 Pro accepts a named `image_size` preset (e.g. 'landscape_4_3', 'square_hd',
// 'portrait_16_9'). Map our UI aspect ratios onto the closest preset; 4:5 has no exact
// preset so we pass explicit dimensions.
function imageSizeForAspect(aspect: AspectRatio): string | { width: number; height: number } {
    switch (aspect) {
        case '1:1':  return 'square_hd';          // 1024×1024
        case '16:9': return 'landscape_16_9';     // 1280×720
        case '9:16': return 'portrait_16_9';      // 720×1280
        case '4:5':  return { width: 1024, height: 1280 };
    }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
    if (!FAL_KEY) throw new FalError('FAL_KEY is not configured.');
    return { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
}

// Fal signals content-policy rejection with 422 (and sometimes 400) plus a detail
// string mentioning safety/NSFW/policy. Distinguish it from generic failures so the
// UI can show the friendly "adjust your text" message and we can refund the credit hold.
function isPolicyRejection(status: number, bodyText: string): boolean {
    if (status !== 422 && status !== 400) return false;
    return /nsfw|safety|content[_ ]?polic|moderation|flagged|prohibited/i.test(bodyText);
}

// Account/billing failures that an operator must resolve (top up / unlock) — not retryable.
// 402 Payment Required, or a 403/429 whose body names a balance/lock/quota condition.
function isServiceUnavailable(status: number, bodyText: string): boolean {
    if (status === 402) return true;
    if (status !== 403 && status !== 429) return false;
    return /balance|exhausted|locked|top[_ ]?up|billing|quota|rate[_ ]?limit/i.test(bodyText);
}

/** Map a non-OK Fal HTTP response to the most specific error type. Always throws. */
function throwForResponse(kind: 'request' | 'poll', status: number, text: string): never {
    if (isPolicyRejection(status, text)) throw new FalContentPolicyError();
    const detail = `${text.slice(0, 300)}`;
    if (isServiceUnavailable(status, text)) {
        throw new FalServiceError(`Fal ${kind} unavailable (${status}): ${detail}`, status);
    }
    throw new FalError(`Fal ${kind} failed (${status}): ${detail}`, status);
}

async function postJson(url: string, payload: unknown): Promise<any> {
    const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) throwForResponse('request', res.status, text);
    return text ? JSON.parse(text) : {};
}

async function getJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const text = await res.text();
    if (!res.ok) throwForResponse('poll', res.status, text);
    return text ? JSON.parse(text) : {};
}

// ── Queue primitives ────────────────────────────────────────────────────────────

/** Submit a job to the Fal queue. Returns the request + polling URLs. */
export async function submit(model: string, input: Record<string, unknown>): Promise<FalSubmitResult> {
    const data = await postJson(`${QUEUE_BASE}/${model}`, input);
    if (!data?.request_id || !data?.status_url || !data?.response_url) {
        throw new FalError('Fal submit returned an unexpected payload.');
    }
    return { requestId: data.request_id, statusUrl: data.status_url, responseUrl: data.response_url };
}

/** Poll a queued job's status. */
export async function status(statusUrl: string): Promise<FalJobStatus> {
    const data = await getJson(statusUrl);
    return (data?.status as FalJobStatus) ?? 'IN_PROGRESS';
}

/** Fetch the final result payload of a COMPLETED job. */
export async function result(responseUrl: string): Promise<any> {
    return getJson(responseUrl);
}

/**
 * Submit then poll until COMPLETED or timeout. Use for fast jobs (images); slow jobs
 * (video) should submit() and poll across requests via a background worker.
 */
async function runSync(model: string, input: Record<string, unknown>, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<any> {
    const timeoutMs  = opts?.timeoutMs  ?? 60_000;
    const intervalMs = opts?.intervalMs ?? 1_500;
    const { statusUrl, responseUrl } = await submit(model, input);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const s = await status(statusUrl);
        if (s === 'COMPLETED') return result(responseUrl);
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new FalError('Fal job timed out before completion.', 504);
}

// ── Public generation helpers ─────────────────────────────────────────────────

/** Generate up to `numImages` image variations with FLUX 1.1 Pro. Resolves to ephemeral Fal URLs. */
export async function generateImages(opts: {
    prompt: string;
    aspectRatio: AspectRatio;
    numImages?: number;
    timeoutMs?: number;
    /** Who this is for, so its cost lands on the right workspace in the COGS view. Recorded either way. */
    usage?: { workspaceId?: number | null; userId?: number | null; assistantId?: number | null };
    /** Leave lettering allowed. Off by default — see NO_TEXT_RULE. */
    allowText?: boolean;
}): Promise<GeneratedImage[]> {
    // FLUX 1.1 Pro auto-routes inference internally — we deliberately DON'T pass legacy SDXL
    // knobs (scheduler / num_inference_steps / guidance_scale); forcing them degrades the model's
    // text rendering. Only prompt, size, count, safety and output format are supplied.
    // Every image, from every assistant: no words in the picture (src/lib/image-prompt.ts says why —
    // FLUX paints text as shapes and misspells it). A caller that truly wants lettering opts out.
    const input: Record<string, unknown> = {
        prompt: opts.allowText ? opts.prompt : `${opts.prompt.trim()}\n\n${NO_TEXT_RULE}`,
        image_size: imageSizeForAspect(opts.aspectRatio),
        num_images: Math.min(Math.max(opts.numImages ?? 4, 1), 4),
        safety_tolerance: SAFETY_TOLERANCE,
        output_format: OUTPUT_FORMAT,
    };
    // Default poll budget must stay UNDER the synchronous Netlify function timeout (26s — see
    // netlify.toml [functions.generate-ai-image]) so an overrun throws a clean FalError('timed
    // out') we can refund, rather than the platform killing the function and returning a raw 502.
    const out = await runSync(IMAGE_MODEL, input, { timeoutMs: opts.timeoutMs ?? 22_000 });
    const images: any[] = out?.images ?? [];
    if (!images.length) throw new FalError('Fal returned no images.');
    // Here, not in each caller: every image path (editor, briefs, autopilot) comes through this one.
    logMediaCost(IMAGE_MODEL, { images }, { ...opts.usage, sessionId: 'fal-image' });
    return images.map(img => ({
        url: img.url,
        width: img.width ?? null,
        height: img.height ?? null,
        contentType: img.content_type ?? 'image/png',
    }));
}

/**
 * One image per prompt, drawn in parallel — the round of four as four different pictures (see
 * image-prompt.ts visualisePrompts). Same cost as one call for four: FLUX is priced per image. A prompt
 * that fails is left out; throws only when none came back.
 */
export async function generateImageVariants(opts: Omit<Parameters<typeof generateImages>[0], 'prompt' | 'numImages'> & { prompts: string[] }): Promise<GeneratedImage[]> {
    const { prompts, ...rest } = opts;
    const settled = await Promise.allSettled(prompts.slice(0, 4).map((prompt) => generateImages({ ...rest, prompt, numImages: 1 })));
    const images = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.slice(0, 1) : []));
    if (!images.length) {
        const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        throw first?.reason instanceof Error ? first.reason : new FalError('Fal returned no images.');
    }
    return images;
}

// Hailuo 2.3 text-to-video accepts only "6" or "10" second clips.
export type VideoDurationSeconds = 6 | 10;
export const VIDEO_DURATIONS: VideoDurationSeconds[] = [6, 10];

/**
 * Submit an async video generation job with Hailuo 2.3 (Standard). Poll with status()/result().
 *
 * The text-to-video endpoint takes only `prompt`, `prompt_optimizer` and a `duration` of "6"|"10".
 * There is NO `aspect_ratio` input — the model infers framing from the prompt and emits a
 * fixed-resolution clip — so we deliberately omit it (passing it 404s/422s on some variants).
 */
export async function submitVideo(opts: {
    prompt: string;
    durationSeconds: VideoDurationSeconds;
}): Promise<FalSubmitResult> {
    const input: Record<string, unknown> = {
        prompt: opts.prompt,
        prompt_optimizer: true,
        duration: String(opts.durationSeconds),
    };
    return submit(VIDEO_MODEL, input);
}

// ── Image-to-video (Video Producer plan, Phase 1) ─────────────────────────────────────────────

/** Is image-to-video switched on? 'off' (or empty) keeps the old Hailuo text-to-video path. */
export function imageToVideoEnabled(model: string = I2V_MODEL): boolean {
    return !!model && model !== 'off';
}

/**
 * Build the request body for an image-to-video model. Pure. Kling's families disagree:
 *   · v2.x  — `image_url`, duration "5" | "10"
 *   · v3/o3 — `start_image_url`, duration "3"…"15", and `generate_audio` (default TRUE — we turn it
 *             off: the soundtrack is ours, from the music library / voiceover, never a model's guess)
 * `billedSeconds` is the clip length actually asked for, for the cost log.
 */
export function imageToVideoInput(model: string, opts: { imageUrl: string; prompt: string; durationSeconds: number }): { input: Record<string, unknown>; billedSeconds: number } {
    const isV3 = /\/(v3|o3)\//.test(model);
    if (isV3) {
        const d = Math.min(Math.max(Math.round(opts.durationSeconds), 3), 15);
        return { input: { prompt: opts.prompt, start_image_url: opts.imageUrl, duration: String(d), generate_audio: false }, billedSeconds: d };
    }
    const d = opts.durationSeconds > 7 ? 10 : 5;
    return { input: { prompt: opts.prompt, image_url: opts.imageUrl, duration: String(d) }, billedSeconds: d };
}

export interface FramedVideoSubmit extends FalSubmitResult {
    /** The model that will be billed — log the cost against this, not VIDEO_MODEL. */
    model: string;
    billedSeconds: number;
    /** The still the clip starts from (null on the text-to-video fallback). */
    frameUrl: string | null;
}

/**
 * Submit one AI clip in the frame you asked for. With image-to-video on: use `startImageUrl` (a
 * product photo, a library picture) or draw one FLUX frame from `imagePrompt` at `aspectRatio`, then
 * animate it with `prompt` (the motion). With it off: the old Hailuo text-to-video. Poll the result
 * with status()/result() exactly as before — the queue shape is the same.
 */
export async function submitFramedVideo(opts: {
    prompt: string;
    imagePrompt?: string;
    startImageUrl?: string | null;
    aspectRatio: AspectRatio;
    durationSeconds: VideoDurationSeconds;
    usage?: { workspaceId?: number | null; userId?: number | null; assistantId?: number | null };
}): Promise<FramedVideoSubmit> {
    if (!imageToVideoEnabled()) {
        const sub = await submitVideo({ prompt: opts.prompt, durationSeconds: opts.durationSeconds });
        return { ...sub, model: VIDEO_MODEL, billedSeconds: opts.durationSeconds, frameUrl: null };
    }
    const frameUrl = opts.startImageUrl
        || (await generateImages({ prompt: opts.imagePrompt || opts.prompt, aspectRatio: opts.aspectRatio, numImages: 1, usage: opts.usage }))[0].url;
    const { input, billedSeconds } = imageToVideoInput(I2V_MODEL, { imageUrl: frameUrl, prompt: opts.prompt, durationSeconds: opts.durationSeconds });
    const sub = await submit(I2V_MODEL, input);
    return { ...sub, model: I2V_MODEL, billedSeconds, frameUrl };
}

/** Extract the mp4 video URL from a COMPLETED Hailuo job result payload. */
export function extractVideo(resultPayload: any): GeneratedVideo {
    const video = resultPayload?.video ?? resultPayload?.videos?.[0];
    if (!video?.url) throw new FalError('Fal video result missing a URL.');
    return { url: video.url, contentType: video.content_type ?? 'video/mp4' };
}
