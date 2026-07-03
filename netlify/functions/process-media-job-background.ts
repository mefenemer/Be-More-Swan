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
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { contentAssets, mediaGenerationJobs, notifications } from '../../db/schema';
import { status as falStatus, result as falResult, extractVideo, falConfigured, FalContentPolicyError } from '../../src/lib/fal-gateway';
import { settleHold } from '../../src/utils/ai-credits';

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const r2Configured = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;   // 12 min, under the 15-min background ceiling
const MOCK_VIDEO_URL = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function persistVideoToR2(orgId: number, url: string, contentType: string): Promise<{ storageKey: string; fileSize: number }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download generated video (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const storageKey = `content/org-${orgId}/generated/${crypto.randomUUID()}.mp4`;
    const s3 = new S3Client({
        region: 'auto', endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: storageKey, Body: bytes, ContentType: contentType || 'video/mp4' }));
    return { storageKey, fileSize: bytes.byteLength };
}

export const handler = async (event: HandlerEvent) => {
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

        if (!falConfigured() || !job.falStatusUrl || !job.falResponseUrl) {
            // Mock mode — simulate a short delay then use a placeholder clip.
            await sleep(3_000);
            videoUrl = MOCK_VIDEO_URL;
        } else {
            // Poll Fal until completion or timeout.
            const deadline = Date.now() + POLL_TIMEOUT_MS;
            while (true) {
                const s = await falStatus(job.falStatusUrl);
                if (s === 'COMPLETED') break;
                if (Date.now() > deadline) { await fail('Video generation timed out.', 'failed'); return { statusCode: 200, body: 'timeout' }; }
                await sleep(POLL_INTERVAL_MS);
            }
            const payload = await falResult(job.falResponseUrl);
            const video = extractVideo(payload);
            videoUrl = video.url;
            videoContentType = video.contentType;
        }

        // Persist durably: R2 when configured, else store the URL directly (mock/dev).
        let storageKey: string | null = null;
        let externalUrl: string | null = null;
        let fileSize: number | null = null;
        if (r2Configured) {
            const stored = await persistVideoToR2(orgId, videoUrl, videoContentType);
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
        await settleHold(db, { orgId, amount: cost, success: true, mediaType: 'video', userId: ownerId, jobId: job.id, isAutonomous: job.isAutonomous });
        await db.update(mediaGenerationJobs)
            .set({ status: 'completed', resultAssetIds: [asset.id], updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));

        // US2 completion notification.
        await db.insert(notifications).values({
            userId: ownerId,
            type: 'media_ready',
            title: 'Your AI video is ready',
            message: 'Your generated video has been added to My Content.',
            metadata: { assetId: asset.id, jobId: job.id },
        }).catch(() => {});

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
};
