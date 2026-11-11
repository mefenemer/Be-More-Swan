// netlify/functions/generate-ai-video.ts
// Epic 1, US2: manual AI video generation — asynchronous.
//
//   POST { prompt, aspectRatio, durationSeconds, imageAssetId? }  → tier check → moderate → hold 5 credits
//          → submit to Fal → create processing job → trigger background poller → { jobId }   (<500ms)
//
// Since 2026-10-31 (Video Producer plan, Phase 1) clips are image-to-video (FAL_I2V_MODEL, Kling):
//   · imageAssetId given → animate that picture from the library; submitted here (no image step).
//   · no picture         → the WORKER draws one FLUX frame at `aspectRatio` and submits it. The frame
//                          takes 5–15 s, too long for this synchronous function.
// So `aspectRatio` is now honoured, not metadata. FAL_I2V_MODEL='off' restores Hailuo text-to-video.
//   GET  ?jobId=N                                  → { status, assetId?, errorMessage? }  (frontend polls)
//
// Video is restricted to the two upper plans (buster/employee) — tierCanGenerateVideo(). Credits are
// held at submit and settled by the background worker (debit on success, refund on failure).

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mediaGenerationJobs, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { presignR2Get } from '../../src/utils/social-publish';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { imageToVideoEnabled, ASPECT_RATIOS, VIDEO_DURATIONS, type AspectRatio, type VideoDurationSeconds } from '../../src/lib/fal-gateway';
import { tierCanGenerateVideo } from '../../src/utils/ai-credits';
import { startAiVideoJob } from '../../src/utils/ai-video-job';
import { withLambda } from '@netlify/aws-lambda-compat';

const PROMPT_MAX = 1000;
// Hailuo 2.3 text-to-video only accepts 6s or 10s clips (see VIDEO_DURATIONS in fal-gateway).
const VALID_DURATIONS = VIDEO_DURATIONS;
// The frame of the clip. Image-to-video honours it (the start frame is drawn at it); the Hailuo
// fallback has no aspect input and only records it. Defaults to a vertical/Reel frame.
const DEFAULT_ASPECT: AspectRatio = '9:16';

export default withLambda(async (event) => {
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
        return { statusCode: 403, body: JSON.stringify({ error: 'video_requires_upgrade', message: 'AI video generation is available on the Busywork Buster and Digital Employee plans.' }) };
    }

    let body: { prompt?: string; aspectRatio?: string; durationSeconds?: number; imageAssetId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const prompt = (body.prompt || '').trim();
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

    // A picture to animate: must be this workspace's own image. Presigned for an hour — fal fetches
    // it once at the start of the job.
    let startImageUrl: string | null = null;
    if (body.imageAssetId != null) {
        if (!imageToVideoEnabled()) return { statusCode: 400, body: JSON.stringify({ error: 'Animating a picture is not available right now.' }) };
        const [img] = await db
            .select({ storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl, assetType: contentAssets.assetType })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, Number(body.imageAssetId)), eq(contentAssets.organisationId, orgId)))
            .limit(1);
        if (!img || img.assetType !== 'image') return { statusCode: 400, body: JSON.stringify({ error: 'That picture could not be found in your library.' }) };
        if (img.storageKey) { try { startImageUrl = await presignR2Get(img.storageKey); } catch { /* fall through */ } }
        if (!startImageUrl) startImageUrl = img.externalUrl;
        if (!startImageUrl) return { statusCode: 400, body: JSON.stringify({ error: 'That picture has no file to animate.' }) };
    }

    // The hold, the job and waking the worker: one path, shared with the Website Assistant's first draft.
    const started = await startAiVideoJob(db, { orgId, userId, prompt, aspectRatio, durationSeconds, startImageUrl, headers: event.headers as Record<string, string | undefined> });
    if (started.ok) {
        return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(started.mock ? { jobId: started.jobId, mock: true } : { jobId: started.jobId }) };
    }
    if (started.reason === 'no_tasks') {
        return { statusCode: 402, body: JSON.stringify({ error: 'insufficient_credits', cost: started.cost, balance: started.balance, unit: started.unit }) };
    }
    if (started.reason === 'policy') {
        return { statusCode: 422, body: JSON.stringify({ error: 'Prompt flagged for policy violation. Please adjust your text and try again.', code: 'POLICY_FLAGGED' }) };
    }
    return { statusCode: 502, body: JSON.stringify({ error: 'Video generation could not be started. Please try again.' }) };
});
