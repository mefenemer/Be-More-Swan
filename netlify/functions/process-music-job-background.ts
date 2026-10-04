// netlify/functions/process-music-job-background.ts
// Finishes an AI music job started by generate-ai-music.ts.
//
// POST { jobId } — polls Stability's /results/{id} until the track exists, stores the bytes in R2
// (Stability's results EXPIRE — a 404 means gone — so the bytes must be ours), creates the
// workspace's content_assets row, settles the credit hold, and marks the job completed. Any failure
// refunds the hold: a customer is never charged for a track they did not get.
//
// A -background function (15-minute ceiling). Stable Audio 3.0 takes seconds to a minute or two for
// a track up to MUSIC_MAX_S; the deadline below is generous and still well inside the ceiling.

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, mediaGenerationJobs } from '../../db/schema';
import { settleHold } from '../../src/utils/ai-credits';
import { persistBufferToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { fetchMusicResult, StabilityPolicyError, StabilityError } from '../../src/lib/stability-audio';
import { musicLabel } from '../../src/lib/music-prompt';
import { withLambda } from '@netlify/aws-lambda-compat';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;
/** Consecutive transient errors (429/5xx/network) tolerated before giving up. */
const MAX_TRANSIENT = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default withLambda(async (event: HandlerEvent) => {
    let jobId: number;
    try { jobId = JSON.parse(event.body || '{}').jobId; }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

    const db = getDb();
    const [job] = await db.select().from(mediaGenerationJobs).where(eq(mediaGenerationJobs.id, jobId)).limit(1);
    if (!job || job.mediaType !== 'audio') return { statusCode: 404, body: 'Job not found' };
    if (job.status !== 'processing') return { statusCode: 200, body: 'Job already settled' };

    const orgId = job.organisationId;
    const cost = job.creditCost;

    async function fail(message: string, statusValue: 'failed' | 'flagged') {
        await settleHold(db, { orgId, amount: cost, success: false, mediaType: 'audio', userId: job.userId });
        await db.update(mediaGenerationJobs).set({ status: statusValue, errorMessage: message, updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));
    }

    // content_assets.user_id is NOT NULL — a job whose user was deleted cannot own an asset. Refund.
    const ownerId = job.userId;
    if (ownerId == null) { await fail('Owning user no longer exists.', 'failed'); return { statusCode: 200, body: 'no owner' }; }
    if (!job.falRequestId) { await fail('Music generation was never started.', 'failed'); return { statusCode: 200, body: 'no id' }; }
    if (!r2IsConfigured()) { await fail('Storage is not configured, so the track could not be kept.', 'failed'); return { statusCode: 200, body: 'no r2' }; }

    try {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let transient = 0;
        let result: Awaited<ReturnType<typeof fetchMusicResult>> = { done: false };
        while (!result.done) {
            if (Date.now() > deadline) { await fail('Music generation timed out.', 'failed'); return { statusCode: 200, body: 'timeout' }; }
            await sleep(POLL_INTERVAL_MS);
            try {
                result = await fetchMusicResult(job.falRequestId);
                transient = 0;
            } catch (err) {
                // A 429 or a blip is worth waiting out; a 4xx about the request itself is not.
                const retryable = !(err instanceof StabilityError) || err.status === 429 || err.status >= 500;
                if (err instanceof StabilityPolicyError || !retryable || ++transient > MAX_TRANSIENT) throw err;
            }
        }

        const stored = await persistBufferToR2({
            orgId, bytes: result.bytes, contentType: result.contentType || 'audio/mpeg', folder: 'generated-music',
        });

        const [asset] = await db.insert(contentAssets).values({
            userId: ownerId, organisationId: orgId,
            name: musicLabel(job.prompt),
            assetType: 'audio', mimeType: result.contentType || 'audio/mpeg',
            fileSize: stored.fileSize, storageKey: stored.storageKey,
            // What was asked for. Stability makes exactly the requested length; the editor still
            // measures the file, so this is the number the picker states before that happens.
            durationS: job.durationSeconds ?? null,
            // Provenance is the answer to "prove you may use this": who made it, from which prompt,
            // with which model (on the job row), and the seed that reproduces it.
            provider: 'stability', providerAssetId: job.falRequestId,
            attributionName: 'Generated with Stable Audio (Stability AI)',
            prompt: job.prompt, aspectRatio: null, generationJobId: job.id,
            status: 'pending',
        }).returning({ id: contentAssets.id });

        await settleHold(db, { orgId, amount: cost, success: true, mediaType: 'audio', userId: ownerId, jobId: job.id });
        await db.update(mediaGenerationJobs)
            .set({ status: 'completed', resultAssetIds: [asset.id], updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));
        return { statusCode: 200, body: 'completed' };
    } catch (err) {
        if (err instanceof StabilityPolicyError) {
            await fail('Stability declined that description.', 'flagged');
        } else {
            console.error('[process-music-job-background] error:', err);
            // The user sees this, so it is a sentence, not a stack.
            await fail(err instanceof StabilityError && err.status === 404
                ? 'The generated track expired before it could be saved. Please try again.'
                : 'Music generation failed. Your credits were not used — please try again.', 'failed');
        }
        return { statusCode: 200, body: 'failed' };
    }
});
