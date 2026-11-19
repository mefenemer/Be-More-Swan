// src/lib/remotion-lambda.ts
//
// Thin gateway over Remotion Lambda — the video-render twin of src/lib/fal-gateway.ts. It wraps the
// two calls the render worker needs (start a distributed render, poll its progress) and centralises
// env-var config + a `remotionConfigured()` guard, so the rest of the app never imports the Remotion
// SDK directly and the worker stays unit-testable by swapping this module.
//
// Config — the deploy procedure is docs/remotion-render.md:
//   REMOTION_LAMBDA_FUNCTION_NAME  the deployed render function
//   REMOTION_SERVE_URL             the deployed composition bundle (S3 site URL)
//   REMOTION_REGION                AWS region, e.g. eu-west-2
//   REMOTION_AWS_ACCESS_KEY_ID / REMOTION_AWS_SECRET_ACCESS_KEY   read by the SDK itself
// When any is missing, remotionConfigured() is false and the caller degrades gracefully rather than
// throwing 500s at reviewers.
//
// The REMOTION_-prefixed credential names are NOT interchangeable with the bare AWS_ ones here. This
// runs on Netlify, i.e. on AWS Lambda, where the runtime already injects AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY for Netlify's OWN execution role. Remotion's resolver order is
// REMOTION_AWS_PROFILE → REMOTION_AWS_* → AWS_PROFILE → AWS_*, so checking only the bare names would
// let a misconfigured environment sail past this guard and authenticate as Netlify, failing deep
// inside the render with an opaque permissions error instead of a clean "not configured".

import { renderMediaOnLambda, getRenderProgress, type AwsRegion } from '@remotion/lambda/client';
import type { Overlay } from './overlay-geometry';
import type { CaptionTrack } from './captions';
import type { StillMotion } from './still-motion';

const REGION = process.env.REMOTION_REGION as AwsRegion | undefined;
const FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
const SERVE_URL = process.env.REMOTION_SERVE_URL;
const COMPOSITION_ID = 'PostOverlay';

// ── The concurrency budget, and why we size the fan-out ourselves ───────────────────────────────
// HISTORY (2026-08-02 to 2026-11-18), kept for why the fan-out is ours: the account then allowed 10
// Lambdas AT ONCE (`npx remotion lambda quotas`, eu-west-2). Today's sizing is the ⚠️ paragraph below.
//
// Remotion's default fan-out knows nothing about that cap. bestFramesPerFunctionParam floors a chunk
// at 20 frames, so the weekly YouTube Short — 10s at 30fps, 300 frames — asks for 15 renderer
// Lambdas, plus the launch function on top: 16 invocations against a limit of 10. EVERY render this
// pipeline has ever attempted was over budget before it started. What a reviewer sees is
//   "AWS Concurrency limit reached (Original Error: Rate Exceeded.)"
// which is thrown at the launch invoke — i.e. the account had not one free slot, because the
// previous render had already grabbed all ten and was still holding them. Renders starve each
// other, and pressing "Try the render again" makes it worse rather than better. Downstream the post
// keeps the still it was supposed to have become, so a video-only platform then refuses it with
// "A Short can't carry this" — a symptom of this, not a separate bug.
//
// So: pick `concurrency` (the renderer-Lambda count) deliberately. The launch function is one MORE
// on top of it, and two renders can legitimately overlap. In that era a cap of 3 kept two renders
// (2 launch + 6 renderers = 8) inside the limit of 10.
//
// ⚠️ The quota has since been RAISED to 1000 (`npx remotion lambda quotas`, eu-west-2, checked 2026-11-18),
// and both environments run the 300 s function (remotion-render-…-300sec). Measured the same day on the
// staging site (Phase 4a, docs/video-producer-screen-walkthrough-plan.md §12): a 2048 MB renderer does about
// 2.6 frames a second on plain 1080p and about 1.4 with a screen cover (two videos decoding). So 3 Lambdas
// was already too few for a 60 s 1080p video with a cover (600 frames each ≈ 430 s, past the 300 s chunk
// timeout), and hopeless for 10 minutes. Size by frames instead: about FRAMES_PER_LAMBDA each, never fewer
// than the 3 a short video always had.
//
// REMOTION_MAX_LAMBDAS caps a single render (default 120: a 10-minute video is 90; two at once, launch
// functions included, are about 182 of the 1000). Lower it only if the quota ever drops back.
const MAX_RENDER_LAMBDAS = Math.max(1, Math.floor(Number(process.env.REMOTION_MAX_LAMBDAS)) || 120);

/** What a short render always used: 3 Lambdas. */
const SHORT_RENDER_LAMBDAS = 3;

// Below about a second of output per Lambda the ~10s cold start dominates the work, so splitting
// further buys nothing.
const MIN_FRAMES_PER_LAMBDA = 30;

/** Frames per renderer: at ~0.73 s a frame with a cover, about 150 s of the 300 s chunk timeout. */
export const FRAMES_PER_LAMBDA = 200;

/**
 * How many renderer Lambdas to spend on a render of `durationInFrames`: about one per FRAMES_PER_LAMBDA,
 * at least 3 for anything a second or more (as always), capped at MAX_RENDER_LAMBDAS.
 *
 * Exported for the tests: this is the whole fix, and it is pure.
 */
export function planConcurrency(durationInFrames: number): number {
    const raw = Math.floor(Number(durationInFrames));
    // Junk (NaN, Infinity, ≤ 0) is one frame: never a NaN, a fraction or a big guess.
    const frames = Number.isFinite(raw) && raw > 0 ? raw : 1;
    const short = Math.min(SHORT_RENDER_LAMBDAS, Math.ceil(frames / MIN_FRAMES_PER_LAMBDA));
    const sized = Math.ceil(frames / FRAMES_PER_LAMBDA);
    return Math.max(1, Math.min(MAX_RENDER_LAMBDAS, Math.max(short, sized)));
}

// Remotion turns the underlying TooManyRequestsException / ConcurrentInvocationLimitExceeded into a
// prose message and — unlike its other failures — throws it WITHOUT retrying. Match on the whole
// error, stack included, because the SDK exception name only shows up there.
export function isConcurrencyError(err: unknown): boolean {
    const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    return /Concurrency limit reached|ConcurrentInvocationLimitExceeded|TooManyRequestsException|Rate ?Exceeded/i.test(text);
}

// A slot frees up when someone else's render finishes, so waiting is the entire remedy. The worker
// is a background function with a 15-minute ceiling and a 10-minute poll budget, so ~50s of backoff
// here is affordable; failing instead costs a human a trip through the Review Queue.
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function remotionConfigured(): boolean {
    return !!(REGION && FUNCTION_NAME && SERVE_URL
        && process.env.REMOTION_AWS_ACCESS_KEY_ID && process.env.REMOTION_AWS_SECRET_ACCESS_KEY);
}

// The composition's inputProps — must match remotion/PostOverlay.tsx PostOverlayProps. Size/fps/length
// are the base clip's real values; calculateMetadata reads them so one composition serves any ratio.
export interface RenderInput {
    videoSrc: string;   // a fetchable URL for the base clip (a presigned R2 GET URL in practice).
                        // Empty when the post is a STILL — imageSrc carries it instead.
    /** A still backdrop. Set instead of videoSrc for a photo + audio post, which has to become an mp4. */
    imageSrc?: string;
    /** Slow movement on that still. Absent = none; ignored by a bundle older than 2026-10-31. */
    imageMotion?: StillMotion;
    /** Timed audio — voice notes and sound. Already resolved to fetchable URLs. */
    audio?: Array<{ id: string; src: string; startS?: number; endS?: number; volume: number; fadeInS?: number; fadeOutS?: number }>;
    /**
     * The user's trim on the base clip. Superseded by `clips`, still sent so that props written by
     * this deploy render correctly on the PREVIOUS site bundle — which a git push does not update.
     */
    videoTrim?: { inS: number; outS: number | null };
    /**
     * The timeline: every clip in order, with its in/out points in seconds against the source.
     * Advisory — the composition intersects each one with the file's real duration, because nothing
     * on this side of the render can open a video to check. See src/lib/video-edit.ts.
     */
    clips?: Array<{ id: string; src: string; inS?: number; outS?: number; gain?: number; kind?: 'image'; holdS?: number; motion?: StillMotion }>;
    /** 'w:h' of the output frame, when it cannot be inherited from a single source clip. */
    targetRatio?: string;
    /**
     * Where the picture sits inside that frame when it has to be cropped to fit. -1..1 per axis,
     * 0 being centred. Set only where a platform re-frames the master. See reframeRatioFor().
     */
    framePosition?: { offsetX: number; offsetY: number };
    overlays: Overlay[];
    /** Voiceover captions (src/lib/captions.ts). Absent when nothing is said — and ignored by a bundle older than 2026-10-31. */
    captions?: CaptionTrack;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
}

// A render is identified by (renderId, bucketName) — both are needed to poll it. Region is carried so
// a config change between start and poll can't misroute the lookup.
export interface StartedRender { renderId: string; bucketName: string; region: string; }

export async function startRender(input: RenderInput): Promise<StartedRender> {
    if (!remotionConfigured()) throw new Error('remotion_not_configured');

    for (let attempt = 0; ; attempt++) {
        try {
            return await launchRender(input);
        } catch (err) {
            // Anything else is a real failure — a bad composition, bad credentials, junk props —
            // and retrying it just burns the worker's clock before failing identically.
            if (!isConcurrencyError(err)) throw err;
            if (attempt >= RATE_LIMIT_BACKOFF_MS.length) {
                // Never let the raw AWS text reach the Review Queue: the reviewer cannot act on a
                // stack trace, and "rate limit" reads as their fault rather than our quota.
                throw new Error(
                    'The video renderer was busy and could not start in time. Try the render again in a few minutes.',
                );
            }
            console.warn(
                `[remotion] concurrency limit hit, retrying in ${RATE_LIMIT_BACKOFF_MS[attempt]}ms (attempt ${attempt + 1}/${RATE_LIMIT_BACKOFF_MS.length})`,
            );
            await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
        }
    }
}

async function launchRender(input: RenderInput): Promise<StartedRender> {
    const { renderId, bucketName } = await renderMediaOnLambda({
        region: REGION!,
        functionName: FUNCTION_NAME!,
        serveUrl: SERVE_URL!,
        composition: COMPOSITION_ID,
        inputProps: input as unknown as Record<string, unknown>,
        codec: 'h264',
        imageFormat: 'jpeg',
        // Sized against the account's Lambda concurrency quota — see MAX_RENDER_LAMBDAS above.
        // Leaving this unset lets Remotion ask for ~15 Lambdas for a 10s clip, which the account
        // cannot supply, and the render dies at the launch invoke.
        concurrency: planConcurrency(input.durationInFrames),
        // 'public' because the worker copies the output with a plain fetch() — a private object would
        // need signing that persistRemoteMediaToR2 does not do. The URL is unguessable (random render
        // id) and short-lived: deleteAfter puts an S3 lifecycle rule on the object so a customer's
        // clip cannot sit in Remotion's bucket indefinitely. The worker copies it into R2 within
        // minutes, so a day is already generous.
        privacy: 'public',
        deleteAfter: '1-day',
        maxRetries: 1,
        downloadBehavior: { type: 'play-in-browser' },
    });
    return { renderId, bucketName, region: REGION! };
}

export interface RenderProgress {
    done: boolean;
    progress: number;        // 0..1
    outputUrl: string | null; // set once done
    error: string | null;     // set on a fatal render error
    /** Remotion's own estimate of the AWS compute spent so far, in USD (its `costs.accruedSoFar`).
     *  Null when it reports another currency or nothing. Read on `done` for the cost line. */
    costUsd: number | null;
}

/** USD cost out of Remotion's `costs` block, or null. Pure. */
export function renderCostUsd(costs: { accruedSoFar?: number; currency?: string } | null | undefined): number | null {
    if (!costs || typeof costs.accruedSoFar !== 'number' || !Number.isFinite(costs.accruedSoFar) || costs.accruedSoFar < 0) return null;
    if (costs.currency && costs.currency.toUpperCase() !== 'USD') return null;
    return costs.accruedSoFar;
}

export async function renderProgress(r: StartedRender): Promise<RenderProgress> {
    const p = await getRenderProgress({
        renderId: r.renderId,
        bucketName: r.bucketName,
        functionName: FUNCTION_NAME!,
        region: (r.region as AwsRegion) || REGION!,
    });
    if (p.fatalErrorEncountered) {
        // The launch function fans out to the renderers itself, so it can hit the SAME account quota
        // we sized `concurrency` against — just one layer deeper, where startRender's retry cannot
        // see it. Give it the same readable sentence rather than a reviewer-facing stack trace.
        const raw = p.errors?.[0]?.message || 'render_failed';
        const error = isConcurrencyError(raw)
            ? 'The video renderer was busy and could not finish. Try the render again in a few minutes.'
            : raw;
        return { done: true, progress: p.overallProgress ?? 0, outputUrl: null, error, costUsd: renderCostUsd(p.costs) };
    }
    return { done: p.done, progress: p.overallProgress ?? 0, outputUrl: p.done ? (p.outputFile ?? null) : null, error: null, costUsd: renderCostUsd(p.costs) };
}
