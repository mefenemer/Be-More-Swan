// src/lib/media-persist.ts
// Generate ONE image with Flux 2 and persist it durably as a content_asset (provider 'fal').
// Used by the autonomous suggestions cron (US5), where there is no human "pick a variation" step.
// Credit accounting is the CALLER's responsibility (hold/settle around this call).

import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { contentAssets } from '../../db/schema';
import { generateImages, falConfigured, type AspectRatio } from './fal-gateway';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const r2Configured = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

function extFromMime(mime: string): string {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    return 'png';
}

/**
 * Generate a single image and store it as a content_asset. Returns the new asset id.
 * Throws FalContentPolicyError / FalError on generation failure (caller refunds the credit hold).
 */
export async function generateAndPersistImage(db: Db, params: {
    orgId: number;
    userId: number;
    prompt: string;
    aspectRatio: AspectRatio;
    generationJobId?: number | null;
}): Promise<number> {
    const image = falConfigured()
        ? (await generateImages({ prompt: params.prompt, aspectRatio: params.aspectRatio, numImages: 1 }))[0]
        : { url: `https://picsum.photos/seed/aura-auto-${Date.now()}/1024/1024`, width: 1024, height: 1024, contentType: 'image/jpeg' };

    const mimeType = image.contentType || 'image/png';
    let storageKey: string | null = null;
    let externalUrl: string | null = null;
    let fileSize: number | null = null;

    if (r2Configured) {
        const res = await fetch(image.url);
        if (!res.ok) throw new Error(`Could not download generated image (${res.status}).`);
        const bytes = Buffer.from(await res.arrayBuffer());
        fileSize = bytes.byteLength;
        storageKey = `content/org-${params.orgId}/generated/${crypto.randomUUID()}.${extFromMime(mimeType)}`;
        const s3 = new S3Client({
            region: 'auto', endpoint: R2_ENDPOINT,
            credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
        });
        await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: storageKey, Body: bytes, ContentType: mimeType }));
    } else {
        externalUrl = image.url;
    }

    const [asset] = await db.insert(contentAssets).values({
        userId: params.userId, organisationId: params.orgId,
        name: `AI image — ${params.prompt.slice(0, 60)}`,
        assetType: 'image', mimeType,
        fileSize, storageKey, externalUrl,
        provider: 'fal', prompt: params.prompt, aspectRatio: params.aspectRatio,
        generationJobId: params.generationJobId ?? null,
        status: 'pending',
    }).returning({ id: contentAssets.id });

    return asset.id;
}
