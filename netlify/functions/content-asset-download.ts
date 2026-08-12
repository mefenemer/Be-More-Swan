// content-asset-download.ts — "Download" in My Content's asset viewer.
//
// GET ?assetId=<id>  → 302 to a presigned R2 URL that forces a save, or the raw bytes
//                      with Content-Disposition: attachment for hotlinked stock media.
//
// ── Why this function has to exist ──────────────────────────────────────────────────────────────
// My Content's Download button used to be a bare <a href={storageUrl} download target="_blank">
// pointed straight at whatever resolveAssetDisplayUrl() returned. That never downloaded anything.
// The HTML `download` attribute is ignored on cross-origin URLs, and EVERY url we hand the browser
// is cross-origin: an R2 presigned URL lives on *.r2.cloudflarestorage.com, a Pexels hotlink on
// images.pexels.com. So the browser did the only other thing it can do with a link — navigated to
// it — and the user got the picture opened in a new tab, which is what they reported as "the
// download button doesn't download".
//
// The attribute cannot be made to work from the client. The origin serving the bytes is the only
// party allowed to say "this is a download", so the instruction has to travel with the response:
// for R2 that is the presigner's response-content-disposition override (same trick as
// storage-download-url.ts does for workspace assets), and for a third-party CDN we cannot set a
// header on someone else's response at all, so we proxy the bytes and set it on ours.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';
import { resolveAssetDisplayUrl } from '../../src/utils/social-publish';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// Netlify caps a function response at 6 MB, and base64 inflates bytes by 4/3 — so 4 MB of source
// media is the most that can come back through the proxy path. Anything larger falls back to a
// redirect: the file opens in a tab instead of saving, which is worse, but it is the pre-existing
// behaviour rather than a broken response. Only ever reached by hotlinked stock media; everything
// we store ourselves goes down the presign path, which has no size limit at all.
const MAX_PROXY_BYTES = 4 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'weba',
};

/**
 * A filename the user's OS will accept, carrying an extension that matches the actual bytes.
 *
 * asset.name is a display label ("Autumn campaign hero") — it routinely has no extension, and can
 * hold anything the user typed. A name without an extension saves as a file the OS cannot open by
 * double-clicking, so the mime type supplies one; the storage key is the fallback because an
 * uploaded object's key keeps the original extension.
 */
function downloadFilename(asset: { name: string; mimeType: string | null; storageKey: string | null; externalUrl: string | null }): string {
    const base = (asset.name || 'asset').replace(/[^\w.\- ]/g, '_').trim().slice(0, 120) || 'asset';
    if (/\.[a-z0-9]{2,4}$/i.test(base)) return base;

    const fromMime = asset.mimeType ? EXT_BY_MIME[asset.mimeType.toLowerCase().split(';')[0].trim()] : null;
    const fromPath = (asset.storageKey || asset.externalUrl || '').split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1];
    const ext = fromMime || fromPath;
    return ext ? `${base}.${ext.toLowerCase()}` : base;
}

// Shared so the three redirect returns below carry one header type rather than three structurally
// different object literals, which is what the handler's response union is checked against.
function redirect(location: string) {
    const headers: Record<string, string> = { Location: location, 'Cache-Control': 'no-store' };
    return { statusCode: 302, headers, body: '' };
}

function r2Configured(): boolean {
    return !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: 'Server misconfigured.' };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: 'Unauthorized.' };

    let userId: number;
    try { userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: 'Invalid session.' }; }

    const assetId = Number(event.queryStringParameters?.assetId);
    if (!Number.isFinite(assetId)) return { statusCode: 400, body: 'assetId is required.' };

    const db = getDb();

    const [asset] = await db
        .select({
            id: contentAssets.id,
            userId: contentAssets.userId,
            name: contentAssets.name,
            assetType: contentAssets.assetType,
            mimeType: contentAssets.mimeType,
            storageKey: contentAssets.storageKey,
            storageUrl: contentAssets.storageUrl,
            externalUrl: contentAssets.externalUrl,
            purgedAt: contentAssets.purgedAt,
        })
        .from(contentAssets)
        .where(eq(contentAssets.id, assetId))
        .limit(1);

    if (!asset) return { statusCode: 404, body: 'Asset not found.' };

    // Scoped to the owner, exactly as the list is (content-assets.ts GET filters on user_id).
    // Anything wider would let a download reach a row its owner's own My Content page never shows.
    if (asset.userId !== userId) return { statusCode: 403, body: 'Forbidden.' };

    // Retention already removed the bytes; the row survives as a tombstone.
    if (asset.purgedAt) return { statusCode: 410, body: 'This asset has been removed.' };

    const filename = downloadFilename(asset);

    // ── Stored with us: let the presigner carry the instruction ─────────────────────────────────
    // response-content-disposition is signed into the URL, so R2 returns it as a real header on the
    // object response and the browser saves rather than renders. 5 minutes is plenty for a redirect
    // the browser follows immediately, and unlike the 10-minute display URLs this one is minted at
    // click time — so a My Content tab left open for an hour still downloads.
    if (asset.storageKey && r2Configured()) {
        const s3 = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_ENDPOINT,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
            },
        });
        const url = await getSignedUrl(s3, new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: asset.storageKey,
            ResponseContentDisposition: `attachment; filename="${filename}"`,
            ...(asset.mimeType ? { ResponseContentType: asset.mimeType } : {}),
        }), { expiresIn: 300 });

        return redirect(url);
    }

    // ── Hotlinked elsewhere: proxy the bytes so the header is ours to set ───────────────────────
    const sourceUrl = await resolveAssetDisplayUrl(asset);
    if (!sourceUrl) return { statusCode: 404, body: 'This asset has no downloadable file.' };

    try {
        const res = await fetch(sourceUrl);
        if (!res.ok) return { statusCode: 502, body: 'Could not fetch the asset from storage.' };

        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_PROXY_BYTES) {
            return redirect(sourceUrl);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        // Re-checked after reading: a chunked response declares no length up front, and the whole
        // point of the cap is that Netlify rejects the oversized response rather than truncating it.
        if (buf.byteLength > MAX_PROXY_BYTES) {
            return redirect(sourceUrl);
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': asset.mimeType || res.headers.get('content-type') || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Cache-Control': 'private, max-age=300',
            },
            body: buf.toString('base64'),
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error(`[content-asset-download] Failed to proxy asset ${assetId}:`, err);
        return { statusCode: 502, body: 'Could not fetch the asset from storage.' };
    }
});
