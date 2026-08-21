// netlify/functions/newsletter-media.ts
// The image behind every <img> in a sent newsletter.
//
//   GET /api/newsletter/media?a=<assetId>&s=<signature>  → 302 to a freshly-resolved media URL
//
// ⚠️ WHY THIS ROUTE EXISTS AT ALL. Every other surface resolves an asset with a presigned R2 URL
// that dies in ten minutes. An email does not get a second chance to resolve anything: it is
// rendered once, sits in an inbox for years, and every picture in it must still load. So the
// snapshot embeds THIS url — stable, permanent, and cheap — and the redirect resolves a fresh
// presigned URL on each fetch.
//
// ⚠️ WHY IT IS UNAUTHENTICATED, AND WHY THAT IS SAFE. A recipient's mail client has no session, so
// this cannot require one — which is why the asset id alone is not the key. The signature is an
// HMAC of the id under JWT_SECRET (src/utils/newsletter-media-url.ts): without it the route
// refuses, so the id space cannot be walked. A token is minted only for an image a tenant has
// deliberately placed in an email that is about to be sent to strangers.
//
// ⚠️ A REDIRECT, NOT A PROXY. Streaming the bytes through a function would hit Netlify's response
// size limit on any real photograph, and would bill every open of every issue as a full transfer.
// media-proxy.ts made the same call for the same reason.

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets } from '../../db/schema';
import { resolveAssetDisplayUrl } from '../../src/utils/social-publish';
import { verifyAssetSignature } from '../../src/utils/newsletter-media-url';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * A 1×1 transparent GIF, served when we cannot produce the image.
 *
 * ⚠️ NOT a 404, and not an error page. A broken-image icon in fifteen hundred inboxes is a
 * permanent, unfixable embarrassment for the sender — the issue has already gone out. A pixel is
 * invisible, and the alt text (which the design always carries) is what the reader sees instead.
 */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pixel = () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=300' },
    body: PIXEL.toString('base64'),
    isBase64Encoded: true,
});

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const assetId = Number(event.queryStringParameters?.a);
    const signature = String(event.queryStringParameters?.s || '');
    if (!Number.isInteger(assetId) || assetId <= 0 || !signature) return pixel();

    // ⚠️ Before the database. An unsigned request must cost us a string comparison, not a query —
    // this endpoint is fetched once per recipient per open, by anyone who has the URL.
    let signed = false;
    try { signed = verifyAssetSignature(assetId, signature); }
    catch { return pixel(); }              // JWT_SECRET missing: fail closed, and never 500 an <img>
    if (!signed) return pixel();

    try {
        const db = getDb();
        const [asset] = await db
            .select({
                assetType: contentAssets.assetType,
                storageUrl: contentAssets.storageUrl,
                storageKey: contentAssets.storageKey,
                externalUrl: contentAssets.externalUrl,
            })
            .from(contentAssets)
            .where(eq(contentAssets.id, assetId))
            .limit(1);
        // Deleted since the issue was sent. The pixel is the honest answer: the picture is gone.
        if (!asset) return pixel();

        const url = await resolveAssetDisplayUrl(asset);
        if (!url) return pixel();

        return {
            statusCode: 302,
            headers: {
                Location: url,
                // ⚠️ The REDIRECT is cacheable for an hour, but never longer than the presigned URL
                // it points at is valid — a cached 302 outliving its target is a broken image that
                // fixes itself only when the cache expires.
                'Cache-Control': 'public, max-age=300',
            },
            body: '',
        };
    } catch (err) {
        console.error('[newsletter-media] resolve failed', { assetId }, err);
        return pixel();
    }
});
