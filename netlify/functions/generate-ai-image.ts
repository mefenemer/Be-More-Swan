// netlify/functions/generate-ai-image.ts
// Epic 1, US1: manual AI image generation for the post-media pool.
//
// Two-step flow (mirrors pexels-search.ts):
//   POST { prompt, aspectRatio }              → moderate → hold 1 credit → Flux 2 (4 variations)
//                                               → on success debit credit, return { jobId, images[] }
//                                               → on policy flag / failure, REFUND the hold (US4 AC)
//   POST { action:'select', jobId, index }    → persist the chosen variation as a content_asset
//                                               (download Fal bytes → R2 storageKey; mock → externalUrl)
//
// Credits: 1 credit per generation (a generation yields up to 4 variations). Selection is free.

import { Handler } from '@netlify/functions';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getDb } from '../../db/client';
import { contentAssets, mediaGenerationJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { orgHasAssistantFeature, featureUnavailableResponse } from '../../src/utils/assistant-capabilities';
import { enforcePromptModeration } from '../../src/utils/moderation';
import {
    generateImages, falConfigured, ASPECT_RATIOS,
    FalContentPolicyError, FalServiceError, FalError, type AspectRatio, type GeneratedImage,
} from '../../src/lib/fal-gateway';
import { holdCredits, settleHold, getBalance, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';

const PROMPT_MAX = 1000;
const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-pro/v1.1';

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME;

function r2Configured(): boolean {
    return !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

function extFromMime(mime: string): string {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    return 'png';
}

// Mock variations when FAL_KEY is absent — keeps the full UI flow demonstrable in dev.
function mockImages(aspect: AspectRatio): GeneratedImage[] {
    const dims: Record<AspectRatio, [number, number]> = {
        '1:1': [800, 800], '16:9': [1280, 720], '9:16': [720, 1280], '4:5': [1024, 1280],
    };
    const [w, h] = dims[aspect];
    return Array.from({ length: 4 }, (_, i) => ({
        url: `https://picsum.photos/seed/aura-${Date.now()}-${i}/${w}/${h}`,
        width: w, height: h, contentType: 'image/jpeg',
    }));
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { action?: string; prompt?: string; aspectRatio?: string; jobId?: number; index?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    // ── SELECT: persist a chosen variation as a content_asset ────────────────────
    if (body.action === 'select') {
        return handleSelect(db, orgId, userId, body.jobId, body.index);
    }

    // ── GENERATE: produce a grid of variations ───────────────────────────────────
    const prompt = (body.prompt || '').trim();
    const aspectRatio = body.aspectRatio as AspectRatio;
    if (!prompt) return { statusCode: 400, body: JSON.stringify({ error: 'A prompt is required.' }) };
    if (prompt.length > PROMPT_MAX) {
        return { statusCode: 400, body: JSON.stringify({ error: `Prompt must be ${PROMPT_MAX} characters or fewer.` }) };
    }
    if (!ASPECT_RATIOS.includes(aspectRatio)) {
        return { statusCode: 400, body: JSON.stringify({ error: `aspectRatio must be one of: ${ASPECT_RATIOS.join(', ')}` }) };
    }

    // Gate: the org must have an active assistant whose TYPE has AI image generation enabled
    // (admin-managed per-type capability). Checked before spending anything.
    if (!await orgHasAssistantFeature(db, orgId, 'ai_image_generation')) {
        return featureUnavailableResponse('None of your assistants can generate AI images.');
    }

    // AC: prompt safety — our own moderation gate BEFORE spending anything (no credit touched).
    const blocked = await enforcePromptModeration({ text: prompt, userId, organisationId: orgId, source: 'generate-ai-image' });
    if (blocked) return blocked;

    // AC: hold the credit; insufficient balance → 402 with upgrade CTA payload.
    const hold = await holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST });
    if (!hold.ok) {
        return {
            statusCode: 402,
            body: JSON.stringify({ error: 'insufficient_credits', cost: IMAGE_CREDIT_COST, balance: hold.balance }),
        };
    }

    try {
        const images = falConfigured()
            ? await generateImages({ prompt, aspectRatio, numImages: 4 })
            : mockImages(aspectRatio);

        // Success → debit the held credit and record the completed job with its candidate URLs.
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId });
        const [job] = await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'image', prompt, aspectRatio,
            model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, status: 'completed',
            candidates: images.map(i => ({ url: i.url, width: i.width, height: i.height, contentType: i.contentType })),
        }).returning({ id: mediaGenerationJobs.id });

        const balance = await getBalance(db, orgId);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId: job.id,
                images: images.map((i, index) => ({ index, url: i.url, width: i.width, height: i.height })),
                balance: balance.balance,
            }),
        };
    } catch (err) {
        // AC: failure/flag must NOT charge — refund the hold.
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId });

        if (err instanceof FalContentPolicyError) {
            await db.insert(mediaGenerationJobs).values({
                organisationId: orgId, userId, mediaType: 'image', prompt, aspectRatio,
                model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, status: 'flagged', errorMessage: err.message,
            });
            return {
                statusCode: 422,
                body: JSON.stringify({ error: 'Prompt flagged for policy violation. Please adjust your text and try again.', code: 'POLICY_FLAGGED' }),
            };
        }

        const message = err instanceof FalError ? err.message : 'Image generation failed. Please try again.';
        await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'image', prompt, aspectRatio,
            model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, status: 'failed', errorMessage: message,
        });

        // Provider account/billing failure (exhausted balance, locked account, throttled): NOT the
        // user's fault and NOT retryable by them — alert loudly and surface an honest message so it
        // isn't mistaken for a transient glitch. Credit is already refunded above.
        if (err instanceof FalServiceError) {
            console.error('[generate-ai-image] FAL SERVICE UNAVAILABLE (operator action needed):', message);
            return {
                statusCode: 503,
                body: JSON.stringify({
                    error: 'AI image generation is temporarily unavailable. Please try again later.',
                    code: 'SERVICE_UNAVAILABLE',
                }),
            };
        }

        console.error('[generate-ai-image] generation error:', message);
        return { statusCode: 502, body: JSON.stringify({ error: 'Image generation failed. Please try again.' }) };
    }
};

async function handleSelect(db: ReturnType<typeof getDb>, orgId: number, userId: number, jobId?: number, index?: number) {
    if (!jobId || index == null || index < 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'jobId and a valid index are required.' }) };
    }

    const [job] = await db
        .select({
            id: mediaGenerationJobs.id,
            prompt: mediaGenerationJobs.prompt,
            aspectRatio: mediaGenerationJobs.aspectRatio,
            candidates: mediaGenerationJobs.candidates,
            resultAssetIds: mediaGenerationJobs.resultAssetIds,
        })
        .from(mediaGenerationJobs)
        .where(and(eq(mediaGenerationJobs.id, jobId), eq(mediaGenerationJobs.organisationId, orgId)))
        .limit(1);
    if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Generation job not found.' }) };

    const candidates = (job.candidates as Array<{ url: string; contentType?: string }>) || [];
    const chosen = candidates[index];
    if (!chosen?.url) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid variation index.' }) };

    const mimeType = chosen.contentType || 'image/png';
    const name = `AI image — ${job.prompt.slice(0, 60)}`;

    let storageKey: string | null = null;
    let externalUrl: string | null = null;
    let fileSize: number | null = null;

    if (r2Configured()) {
        // Download the ephemeral Fal bytes and persist them durably to R2 (Fal URLs expire).
        const res = await fetch(chosen.url);
        if (!res.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Could not retrieve the generated image.' }) };
        const bytes = Buffer.from(await res.arrayBuffer());
        fileSize = bytes.byteLength;
        storageKey = `content/org-${orgId}/generated/${crypto.randomUUID()}.${extFromMime(mimeType)}`;
        const s3 = new S3Client({
            region: 'auto', endpoint: R2_ENDPOINT,
            credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
        });
        await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: storageKey, Body: bytes, ContentType: mimeType }));
    } else {
        // Mock/dev — no R2: store the (non-expiring placeholder) URL directly, like a Pexels hotlink.
        externalUrl = chosen.url;
    }

    const [asset] = await db.insert(contentAssets).values({
        userId, organisationId: orgId,
        name, assetType: 'image', mimeType,
        fileSize, storageKey, externalUrl,
        provider: 'fal',
        prompt: job.prompt,
        aspectRatio: job.aspectRatio,
        generationJobId: job.id,
        status: 'pending',
    }).returning({ id: contentAssets.id });

    // Track the persisted asset on the job (US3 library linkage).
    const ids = Array.isArray(job.resultAssetIds) ? (job.resultAssetIds as number[]) : [];
    await db.update(mediaGenerationJobs)
        .set({ resultAssetIds: [...ids, asset.id], updatedAt: new Date() })
        .where(eq(mediaGenerationJobs.id, job.id));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id }),
    };
}
