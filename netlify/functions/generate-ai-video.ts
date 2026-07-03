// netlify/functions/generate-ai-video.ts
// Epic 1, US2: manual AI video generation (Hailuo 2.3) — asynchronous.
//
//   POST { prompt, aspectRatio, durationSeconds }  → tier check → moderate → hold 5 credits
//          → submit to Fal → create processing job → trigger background poller → { jobId }   (<500ms)
//   GET  ?jobId=N                                  → { status, assetId?, errorMessage? }  (frontend polls)
//
// Video is restricted to premium tiers (saver/employee) — tierCanGenerateVideo(). Credits are
// held at submit and settled by the background worker (debit on success, refund on failure).

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mediaGenerationJobs, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { presignR2Get } from '../../src/utils/social-publish';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import {
    submitVideo, falConfigured, ASPECT_RATIOS, VIDEO_DURATIONS,
    FalContentPolicyError, FalError, type AspectRatio, type VideoDurationSeconds,
} from '../../src/lib/fal-gateway';
import { holdCredits, settleHold, tierCanGenerateVideo, VIDEO_CREDIT_COST } from '../../src/utils/ai-credits';

const PROMPT_MAX = 1000;
const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL ?? 'fal-ai/minimax/hailuo-2.3/standard/text-to-video';
// Hailuo 2.3 text-to-video only accepts 6s or 10s clips (see VIDEO_DURATIONS in fal-gateway).
const VALID_DURATIONS = VIDEO_DURATIONS;
// Hailuo text-to-video has no aspect-ratio input; we still record one on the job/asset for
// downstream display, defaulting to a vertical/Reel frame when the client doesn't supply one.
const DEFAULT_ASPECT: AspectRatio = '9:16';

// Kick the background poller (fire-and-forget). Mirrors triggerExtraction in storage-confirm-upload.
function triggerWorker(headers: Record<string, string | undefined>, jobId: number): void {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[generate-ai-video] no base URL — worker not triggered for job', jobId); return; }
    fetch(`${baseUrl}/.netlify/functions/process-media-job-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
    }).catch(err => console.error('[generate-ai-video] failed to trigger worker:', err));
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    // ── GET: poll job status ────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const jobId = Number(event.queryStringParameters?.jobId);
        if (!Number.isInteger(jobId)) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required.' }) };
        const [job] = await db
            .select({ status: mediaGenerationJobs.status, resultAssetIds: mediaGenerationJobs.resultAssetIds, errorMessage: mediaGenerationJobs.errorMessage })
            .from(mediaGenerationJobs)
            .where(and(eq(mediaGenerationJobs.id, jobId), eq(mediaGenerationJobs.organisationId, orgId)))
            .limit(1);
        if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
        const ids = Array.isArray(job.resultAssetIds) ? (job.resultAssetIds as number[]) : [];
        const assetId = ids[0] ?? null;

        // On completion, resolve a playable URL for the preview (presigned R2 or external/mock URL).
        let videoUrl: string | null = null;
        if (job.status === 'completed' && assetId) {
            const [asset] = await db
                .select({ storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
                .from(contentAssets).where(eq(contentAssets.id, assetId)).limit(1);
            if (asset?.storageKey) { try { videoUrl = await presignR2Get(asset.storageKey); } catch { /* fall through */ } }
            if (!videoUrl && asset?.externalUrl) videoUrl = asset.externalUrl;
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: job.status, assetId, videoUrl, errorMessage: job.errorMessage }),
        };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // ── Tier gate: video is premium-only ─────────────────────────────────────────
    const tierKey = await getActiveTierKeyByOrg(db, orgId);
    if (!tierCanGenerateVideo(tierKey)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'video_requires_upgrade', message: 'AI video generation is available on the Saver and Employee plans.' }) };
    }

    let body: { prompt?: string; aspectRatio?: string; durationSeconds?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const prompt = (body.prompt || '').trim();
    // Aspect ratio is metadata only — the model ignores it — so accept a valid hint or default.
    const aspectRatio: AspectRatio = ASPECT_RATIOS.includes(body.aspectRatio as AspectRatio)
        ? (body.aspectRatio as AspectRatio)
        : DEFAULT_ASPECT;
    const durationSeconds = Number(body.durationSeconds) as VideoDurationSeconds;
    if (!prompt) return { statusCode: 400, body: JSON.stringify({ error: 'A prompt is required.' }) };
    if (prompt.length > PROMPT_MAX) return { statusCode: 400, body: JSON.stringify({ error: `Prompt must be ${PROMPT_MAX} characters or fewer.` }) };
    if (!VALID_DURATIONS.includes(durationSeconds)) return { statusCode: 400, body: JSON.stringify({ error: `durationSeconds must be one of: ${VALID_DURATIONS.join(', ')}` }) };

    // Gate: the org must have an active assistant whose TYPE has AI video generation enabled.
    // Combined with the premium-tier gate above (AND) — both must permit. Before any spend.
    if (!await orgHasAssistantFeature(db, orgId, 'ai_video_generation')) {
        return featureUnavailableResponse('None of your assistants can generate AI videos.');
    }

    // Prompt safety before spending anything.
    const blocked = await enforcePromptModeration({ text: prompt, userId, organisationId: orgId, source: 'generate-ai-video' });
    if (blocked) return blocked;

    // Hold 5 credits; insufficient → 402 with upgrade CTA payload.
    const hold = await holdCredits(db, { orgId, amount: VIDEO_CREDIT_COST });
    if (!hold.ok) {
        return { statusCode: 402, body: JSON.stringify({ error: 'insufficient_credits', cost: VIDEO_CREDIT_COST, balance: hold.balance }) };
    }

    // Submit to Fal. A synchronous content-policy rejection refunds immediately.
    if (!falConfigured()) {
        // Mock mode — create a processing job; the worker completes it with a placeholder.
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'video', prompt, aspectRatio, durationSeconds,
            model: VIDEO_MODEL, creditCost: VIDEO_CREDIT_COST, status: 'processing',
        }).returning({ id: mediaGenerationJobs.id });
        triggerWorker(event.headers as any, job.id);
        return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, mock: true }) };
    }

    try {
        const { requestId, statusUrl, responseUrl } = await submitVideo({ prompt, durationSeconds });
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'video', prompt, aspectRatio, durationSeconds,
            model: VIDEO_MODEL, creditCost: VIDEO_CREDIT_COST, status: 'processing',
            falRequestId: requestId, falStatusUrl: statusUrl, falResponseUrl: responseUrl,
        }).returning({ id: mediaGenerationJobs.id });
        triggerWorker(event.headers as any, job.id);
        return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id }) };
    } catch (err) {
        await settleHold(db, { orgId, amount: VIDEO_CREDIT_COST, success: false, mediaType: 'video', userId });
        if (err instanceof FalContentPolicyError) {
            return { statusCode: 422, body: JSON.stringify({ error: 'Prompt flagged for policy violation. Please adjust your text and try again.', code: 'POLICY_FLAGGED' }) };
        }
        console.error('[generate-ai-video] submit error:', err instanceof FalError ? err.message : err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Video generation could not be started. Please try again.' }) };
    }
};
