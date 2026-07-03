// social-publish.ts — helpers for the LinkedIn/X publisher (publish-social-posts.ts):
// resolve a post's image to fetchable bytes, and refresh an expired X token.
//
// NOTE: the platform media-upload flows that consume resolvePostImage have NOT been
// validated against the live LinkedIn/X APIs — verify with real connected accounts.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { inArray } from 'drizzle-orm';
import { contentAssets } from '../../db/schema';
import { getSecret, storeSecret } from './vault';

function r2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID!,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
    });
}

export async function presignR2Get(key: string, expiresSec = 600): Promise<string> {
    return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }), { expiresIn: expiresSec });
}

// Resolve a displayable URL for a visual asset: S3 uploads already carry a public
// storageUrl; AI-generated images live in the private R2 bucket with only a storageKey,
// so presign a short-lived GET URL; mock/dev assets (Pexels/picsum hotlinks) fall back
// to externalUrl. Used anywhere an asset needs to be shown in the UI (not just publishing).
export async function resolveAssetDisplayUrl(asset: {
    assetType?: string | null;
    storageUrl?: string | null;
    storageKey?: string | null;
    externalUrl?: string | null;
}): Promise<string | null> {
    if (asset.storageUrl) return asset.storageUrl;
    const isVisual = asset.assetType === 'image' || asset.assetType === 'video';
    if (!isVisual) return asset.externalUrl || null;
    if (asset.storageKey) {
        try { return await presignR2Get(asset.storageKey); } catch { /* fall through to externalUrl */ }
    }
    return asset.externalUrl || null;
}

export interface PostImage { url: string; mimeType: string; }

// First image asset attached to the post → a fetchable URL (presigned R2 or external).
// Returns null for text-only posts (caller falls back to a text post).
export async function resolvePostImage(db: any, contentAssetIds: unknown): Promise<PostImage | null> {
    const ids = Array.isArray(contentAssetIds)
        ? contentAssetIds.map(Number).filter(Number.isFinite)
        : [];
    if (!ids.length) return null;

    const rows = await db.select({
        assetType:  contentAssets.assetType,
        mimeType:   contentAssets.mimeType,
        storageKey: contentAssets.storageKey,
        externalUrl: contentAssets.externalUrl,
    }).from(contentAssets).where(inArray(contentAssets.id, ids));

    const img = rows.find((r: any) => (r.assetType ?? '').toLowerCase() === 'image' && (r.storageKey || r.externalUrl));
    if (!img) return null;
    const mimeType = img.mimeType || 'image/jpeg';
    if (img.storageKey) {
        try { return { url: await presignR2Get(img.storageKey), mimeType }; } catch { /* fall through to external */ }
    }
    if (img.externalUrl) return { url: img.externalUrl, mimeType };
    return null;
}

// Refresh an X OAuth2 access token from the stored refresh token; persists and returns
// the new token, or null if refresh isn't possible (no creds / no refresh token / error).
export async function refreshXToken(db: any, vaultRefKey: string): Promise<string | null> {
    const clientId = process.env.X_CLIENT_ID, clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const secret = await getSecret(db, vaultRefKey).catch(() => null) as { token?: string; refreshToken?: string } | null;
    const refreshToken = secret?.refreshToken;
    if (!refreshToken) return null;

    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return null;
    // X rotates refresh tokens — persist the new one (fall back to the old if absent).
    await storeSecret(db, vaultRefKey, { token: data.access_token, refreshToken: data.refresh_token ?? refreshToken });
    return data.access_token as string;
}

// Fetch image bytes from a (presigned/external) URL as an ArrayBuffer (a valid fetch body).
export async function fetchImageBytes(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch media (${res.status})`);
    return res.arrayBuffer();
}
