// src/utils/ai-video-job.ts — start one AI video: hold its tasks, create the job, wake the worker.
// The one way in for generate-ai-video.ts (the picture window) and the Website Assistant's first draft
// (site-draft-media-run.ts). process-media-job-background.ts then polls fal, stores the clip as a
// content_asset, settles the hold (charged on success, free on failure) and marks the job.
//
// Tier, capability and prompt checks are the CALLER's: this starts the job it is told to.

import type { getDb } from '../../db/client';
import { mediaGenerationJobs } from '../../db/schema';
import { aiVideoTasks } from '../config/task-weights';
import { getTaskCosts } from './task-costs';
import {
    submitVideo, submitFramedVideo, imageToVideoEnabled, imageToVideoInput, billedSecondsFor, i2vModel, falConfigured,
    FalContentPolicyError, FalError, type AspectRatio, type VideoDurationSeconds,
} from '../lib/fal-gateway';
import { holdCredits, settleHold, VIDEO_CREDIT_COST } from './ai-credits';
import { resolveBaseUrl } from './base-url';

type Db = ReturnType<typeof getDb>;

const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL ?? 'fal-ai/minimax/hailuo-2.3/standard/text-to-video';

export type StartVideoResult =
    | { ok: true; jobId: number; mock?: boolean }
    | { ok: false; reason: 'no_tasks'; cost: number; balance: number; unit: 'credits' | 'tasks' }
    | { ok: false; reason: 'policy' | 'failed' };

// Kick the background poller. MUST be awaited: on Lambda the runtime freezes as soon as the handler
// returns, so an un-awaited fetch gets frozen mid-flight and never reaches the worker — leaving the
// job stuck 'queued'. Posting to a -background function returns 202 before the work runs, so the
// await only costs the trigger round-trip; the AbortController caps a stalled trigger.
async function triggerWorker(headers: Record<string, string | undefined> | undefined, jobId: number): Promise<void> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[ai-video-job] no base URL — worker not triggered for job', jobId); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/process-media-job-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
            signal: controller.signal,
        });
    } catch (err) {
        console.error('[ai-video-job] failed to trigger worker:', err);
    } finally {
        clearTimeout(timer);
    }
}

/** Never throws for the ordinary outcomes: no tasks, a refused prompt, or fal failing to start. */
export async function startAiVideoJob(db: Db, params: {
    orgId: number; userId: number; prompt: string; aspectRatio: AspectRatio; durationSeconds: VideoDurationSeconds;
    /** A picture to animate. None: the worker draws the first frame. */
    startImageUrl?: string | null;
    /** The request's headers, where there is a request. */
    headers?: Record<string, string | undefined>;
}): Promise<StartVideoResult> {
    const { orgId, userId, prompt, aspectRatio, durationSeconds, headers } = params;
    const startImageUrl = params.startImageUrl ?? null;

    // Hold the clip's tasks; not enough → the caller says so.
    const hold = await holdCredits(db, { orgId, amount: VIDEO_CREDIT_COST, mediaType: 'video', tasks: aiVideoTasks(billedSecondsFor(durationSeconds), await getTaskCosts()) });
    if (!hold.ok) return { ok: false, reason: 'no_tasks', cost: hold.cost, balance: hold.balance, unit: hold.unit };

    // Submit to Fal. A synchronous content-policy rejection refunds immediately.
    if (!falConfigured()) {
        // Mock mode — create a processing job; the worker completes it with a placeholder.
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'video', prompt, aspectRatio, durationSeconds,
            model: VIDEO_MODEL, creditCost: VIDEO_CREDIT_COST, status: 'processing',
        }).returning({ id: mediaGenerationJobs.id });
        await triggerWorker(headers, job.id);
        return { ok: true, jobId: job.id, mock: true };
    }

    // No picture to start from: the worker draws the frame and submits (see generate-ai-video.ts). The
    // job's durationSeconds is the length that will be BILLED, so the cost log prices the real clip.
    if (imageToVideoEnabled() && !startImageUrl) {
        const model = i2vModel();
        const billed = imageToVideoInput(model, { imageUrl: '', prompt, durationSeconds }).billedSeconds;
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'video', prompt, aspectRatio, durationSeconds: billed,
            model, creditCost: VIDEO_CREDIT_COST, status: 'processing',
        }).returning({ id: mediaGenerationJobs.id });
        await triggerWorker(headers, job.id);
        return { ok: true, jobId: job.id };
    }

    try {
        const sub = imageToVideoEnabled()
            ? await submitFramedVideo({ prompt, startImageUrl, aspectRatio, durationSeconds, usage: { workspaceId: orgId, userId } })
            : { ...(await submitVideo({ prompt, durationSeconds })), model: VIDEO_MODEL, billedSeconds: durationSeconds };
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'video', prompt, aspectRatio, durationSeconds: sub.billedSeconds,
            model: sub.model, creditCost: VIDEO_CREDIT_COST, status: 'processing',
            falRequestId: sub.requestId, falStatusUrl: sub.statusUrl, falResponseUrl: sub.responseUrl,
        }).returning({ id: mediaGenerationJobs.id });
        await triggerWorker(headers, job.id);
        return { ok: true, jobId: job.id };
    } catch (err) {
        await settleHold(db, { orgId, amount: VIDEO_CREDIT_COST, success: false, mediaType: 'video', userId });
        if (err instanceof FalContentPolicyError) return { ok: false, reason: 'policy' };
        console.error('[ai-video-job] submit error:', err instanceof FalError ? err.message : err);
        return { ok: false, reason: 'failed' };
    }
}
