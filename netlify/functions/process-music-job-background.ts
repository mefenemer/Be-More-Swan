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
import { contentAssets, mediaGenerationJobs, musicTracks } from '../../db/schema';
import { settleHold } from '../../src/utils/ai-credits';
import { persistBufferToR2, putR2Object, r2IsConfigured } from '../../src/lib/media-persist';
import { fetchMusicResult, StabilityPolicyError, StabilityError } from '../../src/lib/stability-audio';
import { trackName, communityTrackTitle, communityTrackTags, COMMUNITY_TERMS_URL } from '../../src/lib/music-prompt';
import { COMMUNITY_MUSIC_PREFIX } from '../../src/lib/music-library';
import crypto from 'crypto';

type MusicJobMeta = { name?: string; share?: boolean; mood?: string | null; pace?: string | null };
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

        const meta: MusicJobMeta = (Array.isArray(job.candidates) ? (job.candidates as MusicJobMeta[])[0] : null) || {};
        const stored = await persistBufferToR2({
            orgId, bytes: result.bytes, contentType: result.contentType || 'audio/mpeg', folder: 'generated-music',
        });

        const [asset] = await db.insert(contentAssets).values({
            userId: ownerId, organisationId: orgId,
            // The user's name for it, from the job — or the readable default when they gave none.
            name: trackName(meta.name, job.prompt),
            assetType: 'audio', mimeType: result.contentType || 'audio/mpeg',
            fileSize: stored.fileSize, storageKey: stored.storageKey,
            // What was asked for. Stability makes exactly the requested length; the editor still
            // measures the file, so this is the number the picker states before that happens.
            durationS: job.durationSeconds ?? null,
            // Provenance is the answer to "prove you may use this": who made it, from which prompt,
            // with which model (on the job row), and the seed that reproduces it.
            provider: 'stability', providerAssetId: job.falRequestId,
            attributionName: meta.share
                ? 'Generated with Stable Audio · shared with the Be More Swan community'
                : 'Generated with Stable Audio (Stability AI)',
            prompt: job.prompt, aspectRatio: null, generationJobId: job.id,
            status: 'pending',
        }).returning({ id: contentAssets.id });

        await settleHold(db, { orgId, amount: cost, success: true, mediaType: 'audio', userId: ownerId, jobId: job.id });

        // ── Shared with the community: into the library every workspace can browse ───────────────
        // After the customer has their track and has been charged the shared price, and isolated so a
        // failure here never takes their track away from them. It is logged loudly instead: they paid
        // less on the understanding the track would be shared, and that needs fixing by hand.
        if (meta.share) {
            try {
                // A COPY in the shared library's own folder. The customer's object lives under
                // content/org-N/, which their workspace's deletion and retention sweep — a library
                // track pointing there would vanish for everyone the day they leave.
                const key = `${COMMUNITY_MUSIC_PREFIX}/${crypto.randomUUID()}.mp3`;
                await putR2Object({ key, bytes: result.bytes, contentType: result.contentType || 'audio/mpeg' });
                await db.insert(musicTracks).values({
                    // Never the customer's own name or description for it — see communityTrackTitle.
                    title: communityTrackTitle(meta.mood, meta.pace, job.id),
                    artist: 'Be More Swan community',
                    storageKey: key,
                    durationS: job.durationSeconds ?? 30,
                    tags: communityTrackTags(meta.mood, meta.pace),
                    licenceName: 'Be More Swan Community Music (AI-generated with Stable Audio)',
                    licenceTermsUrl: COMMUNITY_TERMS_URL,
                    attributionRequired: false,
                    source: 'Be More Swan community — Stable Audio 3.0 (Stability AI)',
                    // Provenance: the job holds the prompt, the model, and the consent record.
                    sourceReference: `media_generation_jobs:${job.id}`,
                });
            } catch (shareErr) {
                console.error(`[process-music-job-background] SHARE FAILED for job ${job.id} — the customer paid the shared price but the track is NOT in the community library:`, shareErr);
            }
        }
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
