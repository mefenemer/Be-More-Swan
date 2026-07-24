// src/lib/remotion-lambda.ts
//
// Thin gateway over Remotion Lambda — the video-render twin of src/lib/fal-gateway.ts. It wraps the
// two calls the render worker needs (start a distributed render, poll its progress) and centralises
// env-var config + a `remotionConfigured()` guard, so the rest of the app never imports the Remotion
// SDK directly and the worker stays unit-testable by swapping this module.
//
// Config (set in Stage 6 deploy; see docs/remotion-render.md):
//   REMOTION_LAMBDA_FUNCTION_NAME  the deployed render function
//   REMOTION_SERVE_URL             the deployed composition bundle (S3 site URL)
//   REMOTION_REGION                AWS region, e.g. us-east-1
//   REMOTION_AWS_ACCESS_KEY_ID / REMOTION_AWS_SECRET_ACCESS_KEY   read by the SDK itself
// When any is missing, remotionConfigured() is false and the caller degrades gracefully rather than
// throwing 500s at reviewers.

import { renderMediaOnLambda, getRenderProgress, type AwsRegion } from '@remotion/lambda/client';
import type { Overlay } from './overlay-geometry';

const REGION = process.env.REMOTION_REGION as AwsRegion | undefined;
const FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME;
const SERVE_URL = process.env.REMOTION_SERVE_URL;
const COMPOSITION_ID = 'PostOverlay';

export function remotionConfigured(): boolean {
    return !!(REGION && FUNCTION_NAME && SERVE_URL
        && process.env.REMOTION_AWS_ACCESS_KEY_ID && process.env.REMOTION_AWS_SECRET_ACCESS_KEY);
}

// The composition's inputProps — must match remotion/PostOverlay.tsx PostOverlayProps. Size/fps/length
// are the base clip's real values; calculateMetadata reads them so one composition serves any ratio.
export interface RenderInput {
    videoSrc: string;   // a fetchable URL for the base clip (a presigned R2 GET URL in practice)
    overlays: Overlay[];
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
    const { renderId, bucketName } = await renderMediaOnLambda({
        region: REGION!,
        functionName: FUNCTION_NAME!,
        serveUrl: SERVE_URL!,
        composition: COMPOSITION_ID,
        inputProps: input as unknown as Record<string, unknown>,
        codec: 'h264',
        imageFormat: 'jpeg',
        privacy: 'public',
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
}

export async function renderProgress(r: StartedRender): Promise<RenderProgress> {
    const p = await getRenderProgress({
        renderId: r.renderId,
        bucketName: r.bucketName,
        functionName: FUNCTION_NAME!,
        region: (r.region as AwsRegion) || REGION!,
    });
    if (p.fatalErrorEncountered) {
        return { done: true, progress: p.overallProgress ?? 0, outputUrl: null, error: p.errors?.[0]?.message || 'render_failed' };
    }
    return { done: p.done, progress: p.overallProgress ?? 0, outputUrl: p.done ? (p.outputFile ?? null) : null, error: null };
}
