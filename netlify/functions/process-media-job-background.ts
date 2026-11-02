// netlify/functions/process-media-job-background.ts
// Epic 1, US2: background worker that completes an async AI video job.
//
// POST { jobId }  — polls Fal until the video is ready (or times out), downloads the mp4 to R2,
// creates a content_assets row (provider 'fal', type 'video'), settles the credit hold, marks the
// job completed, and notifies the user. On failure/timeout/policy-flag it refunds the hold.
//
// Netlify background functions (filename ends in `-background`) run async with a 15-minute ceiling,
// which comfortably covers Hailuo 2.3 generation. Triggered fire-and-forget by generate-ai-video.ts.

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, mediaGenerationJobs } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import {
    status as falStatus, result as falResult, extractVideo, falConfigured, FalContentPolicyError,
    submitFramedVideo, ASPECT_RATIOS, type AspectRatio, type VideoDurationSeconds,
} from '../../src/lib/fal-gateway';
import { logMediaCost } from '../../src/utils/ai-usage';
import { settleHold } from '../../src/utils/ai-credits';
import { aiVideoTasks } from '../../src/config/task-weights';
import { persistRemoteMediaToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { withLambda } from '@netlify/aws-lambda-compat';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;   // 12 min, under the 15-min background ceiling
const MOCK_VIDEO_URL = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default withLambda(async (event: HandlerEvent) => {
    let jobId: number;
    try { jobId = JSON.parse(event.body || '{}').jobId; }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

    const db = getDb();
    const [job] = await db.select().from(mediaGenerationJobs).where(eq(mediaGenerationJobs.id, jobId)).limit(1);
    if (!job) return { statusCode: 404, body: 'Job not found' };
    if (job.status !== 'processing') return { statusCode: 200, body: 'Job already settled' };

    const orgId = job.organisationId;
    const cost = job.creditCost;

    // content_assets.userId is NOT NULL; a job whose user was deleted can't be attributed — refund.
    const ownerId = job.userId;
    if (ownerId == null) {
        await settleHold(db, { orgId, amount: cost, success: false, mediaType: 'video', userId: null });
        await db.update(mediaGenerationJobs).set({ status: 'failed', errorMessage: 'Owning user no longer exists.', updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, jobId));
        return { statusCode: 200, body: 'no owner' };
    }

    async function fail(message: string, statusValue: 'failed' | 'flagged') {
        await settleHold(db, { orgId, amount: cost, success: false, mediaType: 'video', userId: job.userId });
        await db.update(mediaGenerationJobs).set({ status: statusValue, errorMessage: message, updatedAt: new Date() }).where(eq(mediaGenerationJobs.id, jobId));
    }

    try {
        let videoUrl: string;
        let videoContentType = 'video/mp4';

        if (!falConfigured()) {
            // Mock mode — simulate a short delay then use a placeholder clip.
            await sleep(3_000);
            videoUrl = MOCK_VIDEO_URL;
        } else {
            // Image-to-video with no picture supplied (generate-ai-video): draw the start frame and
            // submit HERE — the frame takes 5–15 s, too long for the synchronous request. The URLs are
            // written back so a re-run of this worker polls instead of submitting (and paying) twice.
            let statusUrl = job.falStatusUrl;
            let responseUrl = job.falResponseUrl;
            if (!statusUrl || !responseUrl) {
                const aspectRatio: AspectRatio = ASPECT_RATIOS.includes(job.aspectRatio as AspectRatio) ? (job.aspectRatio as AspectRatio) : '9:16';
                const sub = await submitFramedVideo({
                    prompt: job.prompt, aspectRatio,
                    durationSeconds: ((job.durationSeconds ?? 6) > 7 ? 10 : 6) as VideoDurationSeconds,
                    usage: { workspaceId: orgId, userId: job.userId, assistantId: job.assistantId ?? null },
                });
                statusUrl = sub.statusUrl;
                responseUrl = sub.responseUrl;
                await db.update(mediaGenerationJobs)
                    .set({ falRequestId: sub.requestId, falStatusUrl: statusUrl, falResponseUrl: responseUrl, updatedAt: new Date() })
                    .where(eq(mediaGenerationJobs.id, jobId));
            }
            // Poll Fal until completion or timeout.
            const deadline = Date.now() + POLL_TIMEOUT_MS;
            while (true) {
                const s = await falStatus(statusUrl);
                if (s === 'COMPLETED') break;
                if (Date.now() > deadline) { await fail('Video generation timed out.', 'failed'); return { statusCode: 200, body: 'timeout' }; }
                await sleep(POLL_INTERVAL_MS);
            }
            const payload = await falResult(responseUrl);
            const video = extractVideo(payload);
            // Charged by fal on a COMPLETED job, so recorded here rather than at submit.
            logMediaCost(job.model, { durationSeconds: job.durationSeconds ?? 6 }, { workspaceId: orgId, userId: job.userId, assistantId: job.assistantId ?? null, sessionId: 'fal-video' });
            videoUrl = video.url;
            videoContentType = video.contentType;
        }

        // Persist durably: R2 when configured, else store the URL directly (mock/dev).
        let storageKey: string | null = null;
        let externalUrl: string | null = null;
        let fileSize: number | null = null;
        if (r2IsConfigured()) {
            const stored = await persistRemoteMediaToR2({
                orgId, url: videoUrl, contentType: videoContentType || 'video/mp4', label: 'generated video',
            });
            storageKey = stored.storageKey;
            fileSize = stored.fileSize;
        } else {
            externalUrl = videoUrl;
        }

        const [asset] = await db.insert(contentAssets).values({
            userId: ownerId, organisationId: orgId,
            name: `AI video — ${job.prompt.slice(0, 60)}`,
            assetType: 'video', mimeType: 'video/mp4',
            fileSize, storageKey, externalUrl,
            provider: 'fal', prompt: job.prompt, aspectRatio: job.aspectRatio, generationJobId: job.id,
            status: 'pending',
        }).returning({ id: contentAssets.id });

        // Settle the hold as a successful debit, mark job complete.
        // job.durationSeconds is the BILLED length (generate-ai-video stores sub.billedSeconds).
        await settleHold(db, { orgId, amount: cost, success: true, mediaType: 'video', userId: ownerId, jobId: job.id, isAutonomous: job.isAutonomous, assistantId: job.assistantId ?? null, tasks: aiVideoTasks(job.durationSeconds) });
        await db.update(mediaGenerationJobs)
            .set({ status: 'completed', resultAssetIds: [asset.id], updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));

        // US2 completion notification.
        await createNotification(db, 'media_ready', {
            userId: ownerId,
            metadata: { assetId: asset.id, jobId: job.id },
        });

        return { statusCode: 200, body: 'completed' };
    } catch (err) {
        if (err instanceof FalContentPolicyError) {
            await fail('Prompt flagged for policy violation.', 'flagged');
        } else {
            console.error('[process-media-job-background] error:', err);
            await fail(err instanceof Error ? err.message : 'Video generation failed.', 'failed');
        }
        return { statusCode: 200, body: 'failed' };
    }
});
