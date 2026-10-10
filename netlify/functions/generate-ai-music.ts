// netlify/functions/generate-ai-music.ts
// "✨ Generate music" in the post editor's Sound layer — Stable Audio 3.0, asynchronous.
//
//   POST { description?, mood?, pace?, durationS, postId?, name?, share }
//        → feature gate → our prompt rules → moderation → hold musicCreditCost(share) credits
//        → submit to Stability → create a processing job → trigger the background worker → { jobId }
//   GET  ?jobId=N → { status, assetId?, url?, label?, durationS?, errorMessage? }   (editor polls)
//
// The same shape as generate-ai-video.ts on purpose: hold at submit, settle in the worker (debit on
// success, refund on failure), and a job row the editor can poll after the request has returned.
// Differences, each deliberate:
//   • No tier gate. Video is premium-only; music is priced like it but gated like IMAGES — any paid
//     tier with credits. A track under a photo post is as ordinary as an AI image is.
//   • Gated by its own 'ai_music_generation' assistant feature (2026-10-10). It used to borrow the
//     AI-image switch, so turning images off for a fal outage took music down too, though music runs
//     on Stability. db/z-music-capability.sql copied the image grants so nobody lost music on deploy.
//   • No mock mode. A placeholder track would sit on a real post looking like generated music; with
//     no STABILITY_API_KEY the button says it is not available instead.

import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mediaGenerationJobs, contentAssets, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { presignR2Get } from '../../src/utils/social-publish';
import { holdCredits, settleHold, musicCreditCost } from '../../src/utils/ai-credits';
import { buildMusicPrompt, trackName, COMMUNITY_TERMS_CLAUSE } from '../../src/lib/music-prompt';
import { submitMusic, stabilityConfigured, StabilityPolicyError, StabilityError, MUSIC_MODEL } from '../../src/lib/stability-audio';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// MUST be awaited — see generate-ai-video.ts. An un-awaited fetch is frozen when the handler returns
// and the job sits 'processing' for ever with the credits held.
async function triggerWorker(headers: Record<string, string | undefined>, jobId: number): Promise<void> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[generate-ai-music] no base URL — worker not triggered for job', jobId); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/process-music-job-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
            signal: controller.signal,
        });
    } catch (err) {
        console.error('[generate-ai-music] failed to trigger worker:', err);
    } finally {
        clearTimeout(timer);
    }
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    // ── GET: poll ───────────────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const jobId = Number(event.queryStringParameters?.jobId);
        if (!Number.isInteger(jobId)) return json(400, { error: 'jobId required.' });
        const [job] = await db
            .select({
                status: mediaGenerationJobs.status, resultAssetIds: mediaGenerationJobs.resultAssetIds,
                errorMessage: mediaGenerationJobs.errorMessage, mediaType: mediaGenerationJobs.mediaType,
            })
            .from(mediaGenerationJobs)
            .where(and(eq(mediaGenerationJobs.id, jobId), eq(mediaGenerationJobs.organisationId, orgId)))
            .limit(1);
        if (!job || job.mediaType !== 'audio') return json(404, { error: 'Job not found.' });
        const ids = Array.isArray(job.resultAssetIds) ? (job.resultAssetIds as number[]) : [];
        const assetId = ids[0] ?? null;

        let url: string | null = null;
        let label: string | null = null;
        let durationS: number | null = null;
        if (job.status === 'completed' && assetId) {
            const [asset] = await db
                .select({ storageKey: contentAssets.storageKey, name: contentAssets.name, durationS: contentAssets.durationS })
                .from(contentAssets)
                .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId)))
                .limit(1);
            if (asset?.storageKey) url = await presignR2Get(asset.storageKey).catch(() => null);
            label = asset?.name ?? null;
            durationS = asset?.durationS ?? null;
        }
        return json(200, { status: job.status, assetId, url, label, durationS, errorMessage: job.errorMessage });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!stabilityConfigured()) {
        return json(503, { error: 'not_configured', message: 'Music generation is not switched on yet.' });
    }

    let body: { description?: string; mood?: string; pace?: string; durationS?: number; postId?: number; name?: string; share?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    // A post id, when given, must be this workspace's — the same check music-library's select makes.
    const postId = Number(body.postId);
    if (Number.isInteger(postId) && postId > 0) {
        const [post] = await db.select({ id: scheduledPosts.id }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId))).limit(1);
        if (!post) return json(404, { error: 'Post not found.' });
    }

    // Our rules first: instrumental only, no named artists. Free, and explains itself.
    const built = buildMusicPrompt(body);
    if (!built.ok) return json(400, { error: built.error, code: 'PROMPT_RULES' });

    // Its own switch since 2026-10-10 (db/z-music-capability.sql) — it used to ride on AI images.
    if (!await orgHasAssistantFeature(db, orgId, 'ai_music_generation')) {
        return featureUnavailableResponse('None of your assistants can generate AI music.');
    }

    // The user's own words through the same moderation every other generator uses, before any spend.
    const blocked = await enforcePromptModeration({
        text: built.prompt, userId, organisationId: orgId, source: 'generate-ai-music',
    });
    if (blocked) return blocked;

    // ── Shared with the community, or private and owned outright ─────────────────────────────────
    // ⚠️ Shared ONLY on an explicit `share: true`. The panel defaults to sharing and always sends the
    // choice, but this is the customer giving up ownership of what they made (terms §11.8) — a missing
    // or malformed field is not consent, so it is the private, full-price answer.
    const shared = body.share === true;
    const cost = musicCreditCost(shared);

    const hold = await holdCredits(db, { orgId, amount: cost });
    if (!hold.ok) return json(402, { error: 'insufficient_credits', cost, balance: hold.balance });

    // ⚠️ The job row BEFORE the Stability call. The other way round, a failed insert (the CHECK not yet
    // widened on this database, say) would leave a generation running at Stability — billed to us on
    // success — with nothing here that knows it exists.
    let jobId: number;
    try {
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'audio', prompt: built.prompt,
            aspectRatio: 'none', durationSeconds: built.durationS,
            model: MUSIC_MODEL, creditCost: cost, status: 'processing',
            // What the worker needs beyond the prompt, in `candidates` (unused for audio) rather than
            // new columns — see db/z-ai-music-generation.sql for why this table must not grow one
            // ahead of its migration. The sharing choice is the CONSENT RECORD: who agreed, when, to
            // which clause — the answer to "did this customer agree to give us this track?".
            candidates: [{
                name: trackName(body.name, built.prompt),
                share: shared,
                mood: body.mood ?? null,
                pace: body.pace ?? null,
                ...(shared ? { consent: { userId, at: new Date().toISOString(), termsClause: COMMUNITY_TERMS_CLAUSE } } : {}),
            }],
        }).returning({ id: mediaGenerationJobs.id });
        jobId = job.id;
    } catch (err) {
        await settleHold(db, { orgId, amount: cost, success: false, mediaType: 'audio', userId });
        console.error('[generate-ai-music] could not record the job (is db/z-ai-music-generation.sql applied?):', err);
        return json(500, { error: 'Music generation is not available right now. Your credits were not used.' });
    }

    const failJob = async (message: string, status: 'failed' | 'flagged') => {
        await settleHold(db, { orgId, amount: cost, success: false, mediaType: 'audio', userId });
        await db.update(mediaGenerationJobs).set({ status, errorMessage: message, updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));
    };

    try {
        const { id } = await submitMusic({ prompt: built.prompt, durationS: built.durationS });
        // The column is named for the first provider; it holds Stability's generation id here.
        await db.update(mediaGenerationJobs).set({ falRequestId: id, updatedAt: new Date() })
            .where(eq(mediaGenerationJobs.id, jobId));
    } catch (err) {
        if (err instanceof StabilityPolicyError) {
            await failJob('Stability declined that description.', 'flagged');
            return json(422, { error: 'Stability declined that description. Try different words.', code: 'POLICY_FLAGGED' });
        }
        console.error('[generate-ai-music] submit error:', err instanceof StabilityError ? `${err.status} ${err.message}` : err);
        await failJob('Music generation could not be started.', 'failed');
        return json(502, { error: 'Music generation could not be started. Your credits were not used — please try again.' });
    }

    await triggerWorker(event.headers as any, jobId);
    return json(202, { jobId, cost, shared, durationS: built.durationS });
});
