// src/lib/media-persist.ts
// Durable media persistence for the Content Library.
//
// Exports:
//   persistRemoteMediaToR2 — download a remote URL into R2 and hand back the key (the shared
//     primitive; used wherever a provider hands us a URL that expires).
//   persistBufferToR2 — same, for bytes we produced ourselves rather than fetched.
//   generateAndPersistImage — generate ONE image with Flux 2 and persist it as a content_asset
//     (provider 'fal'). Used by the autonomous suggestions cron (US5), where there is no human
//     "pick a variation" step. Credit accounting is the CALLER's responsibility.
//   renderAndPersistBrandCard — render a typographic brand card and persist it (provider
//     'brand_card'). Costs no AI credits — nothing is generated, only drawn.

import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { contentAssets } from '../../db/schema';
import { generateImages, falConfigured, type AspectRatio } from './fal-gateway';
import { renderBrandCard, type CardVariant } from './brand-card';
import type { BrandKit } from '../utils/brand-kit';
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
    return persistBufferToR2({ ...params, bytes: Buffer.from(await res.arrayBuffer()) });
}

/**
 * Store bytes we already hold in R2 under the org's content/ prefix.
 *
 * Same destination and key shape as persistRemoteMediaToR2, minus the download — for media the
 * platform RENDERS rather than fetches (brand cards today). Callers must check r2IsConfigured():
 * without R2 there is nowhere to put bytes that have no URL of their own, and unlike a provider
 * URL there is no fallback to fall back to.
 */
export async function persistBufferToR2(params: {
    orgId: number;
    bytes: Buffer;
    contentType: string;
    folder?: string;
}): Promise<{ storageKey: string; fileSize: number }> {
    const storageKey = `content/org-${params.orgId}/${params.folder || 'generated'}/${crypto.randomUUID()}.${extFromMime(params.contentType)}`;
    const s3 = new S3Client({
        region: 'auto', endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: storageKey, Body: params.bytes, ContentType: params.contentType }));
    return { storageKey, fileSize: params.bytes.byteLength };
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

/**
 * Render a brand card for a post and store it as a content_asset (provider 'brand_card').
 * Returns the new asset id.
 *
 * Throws when R2 is unconfigured: a card exists only as bytes we just made, so with nowhere to put
 * them there is no asset to point a post at. The resolver treats the throw as "source produced
 * nothing" and moves to the next one, which is the right outcome — never a post with a dead image.
 */
export async function renderAndPersistBrandCard(db: Db, params: {
    orgId: number;
    userId: number;
    headline: string;
    kit: BrandKit;
    aspectRatio: AspectRatio;
    /** Post id — alternates the card's polarity and keeps a re-render identical. */
    seed?: number;
    variant?: CardVariant;
    orgName?: string | null;
}): Promise<number> {
    if (!r2Configured) throw new Error('brand_card_requires_r2');

    const card = await renderBrandCard({
        headline: params.headline,
        kit: params.kit,
        aspectRatio: params.aspectRatio,
        variant: params.variant,
        seed: params.seed,
        orgName: params.orgName,
    });

    const { storageKey, fileSize } = await persistBufferToR2({
        orgId: params.orgId, bytes: card.png, contentType: 'image/png', folder: 'brand-cards',
    });

    const [asset] = await db.insert(contentAssets).values({
        userId: params.userId, organisationId: params.orgId,
        name: `Brand card — ${card.headline.slice(0, 60)}`,
        assetType: 'image', mimeType: 'image/png',
        fileSize, storageKey, externalUrl: null,
        provider: 'brand_card',
        // The headline IS the prompt here: it is the whole input the image was derived from, so
        // storing it makes the card reproducible from the row alone.
        prompt: card.headline,
        aspectRatio: params.aspectRatio,
        width: card.width, height: card.height,
        // Everything the review-time editor needs to reopen and re-render this exact card. The kit
        // is stored WHOLE rather than as a reference to the org's: the org kit can change later,
        // and re-rendering a card the user already approved must not silently restyle it.
        // `layout` rides along so the review-time editor seeds its toggles and drag handles from
        // what this card was actually drawn with, not from the defaults.
        renderParams: { kind: 'brand_card', headline: card.headline, variant: card.variant, kit: params.kit, layout: card.layout },
        status: 'pending',
    }).returning({ id: contentAssets.id });

    return asset.id;
}
