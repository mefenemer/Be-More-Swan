// src/lib/media-persist.ts
// Durable media persistence for the Content Library.
//
// Two exports:
//   persistRemoteMediaToR2 — download a remote URL into R2 and hand back the key (the shared
//     primitive; used wherever a provider hands us a URL that expires).
//   generateAndPersistImage — generate ONE image with Flux 2 and persist it as a content_asset
//     (provider 'fal'). Used by the autonomous suggestions cron (US5), where there is no human
//     "pick a variation" step. Credit accounting is the CALLER's responsibility.

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

export function extFromMime(mime: string): string {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('quicktime')) return 'mov';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('gif')) return 'gif';
    return 'png';
}

export function r2IsConfigured(): boolean {
    return r2Configured;
}

/**
 * Download a remote URL and store the bytes in R2 under the org's content/ prefix.
 * Returns the storage key and byte size.
 *
 * Use this for any provider whose URLs expire — Fal result URLs and Canva export downloads
 * (24h) both rot, so the bytes must be ours. It is deliberately NOT used for Pexels, whose
 * terms require hotlinking their CDN (see src/utils/pexels.ts).
 *
 * Callers must check r2IsConfigured() first: with no R2 there is nowhere to put the bytes and
 * the only honest fallback (keeping the expiring URL as externalUrl) is the caller's decision.
 */
export async function persistRemoteMediaToR2(params: {
    orgId: number;
    url: string;
    contentType: string;
    /** Key segment under content/org-N/ — e.g. 'generated', 'canva'. */
    folder?: string;
    label?: string;
}): Promise<{ storageKey: string; fileSize: number }> {
    const res = await fetch(params.url);
    if (!res.ok) throw new Error(`Could not download ${params.label || 'media'} (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const storageKey = `content/org-${params.orgId}/${params.folder || 'generated'}/${crypto.randomUUID()}.${extFromMime(params.contentType)}`;
    const s3 = new S3Client({
        region: 'auto', endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: storageKey, Body: bytes, ContentType: params.contentType }));
    return { storageKey, fileSize: bytes.byteLength };
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
        const stored = await persistRemoteMediaToR2({
            orgId: params.orgId, url: image.url, contentType: mimeType, label: 'generated image',
        });
        storageKey = stored.storageKey;
        fileSize = stored.fileSize;
    } else {
        externalUrl = image.url;
    }

    const [asset] = await db.insert(contentAssets).values({
        userId: params.userId, organisationId: params.orgId,
        name: `AI image — ${params.prompt.slice(0, 60)}`,
        assetType: 'image', mimeType,
        fileSize, storageKey, externalUrl,
        provider: 'fal', prompt: params.prompt, aspectRatio: params.aspectRatio,
        // fal already returns the real dimensions; they were being discarded. Storing them lets the
        // platform preview verify the generated image actually matches the slot's ratio rather than
        // assuming it does because we asked for it.
        width: image.width || null,
        height: image.height || null,
        generationJobId: params.generationJobId ?? null,
        status: 'pending',
    }).returning({ id: contentAssets.id });

    return asset.id;
}
