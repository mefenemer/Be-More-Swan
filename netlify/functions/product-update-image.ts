// netlify/functions/product-update-image.ts
// The screenshot behind every <img> in a "What's new" email.
//
//   GET /api/product-updates/image?i=<imageId>&s=<signature>  → the image bytes
//
// Unauthenticated because a mail client has no session; the HMAC signature
// (src/utils/product-update-email.ts) is what stops the id space being walked.
//
// Bytes, not a redirect: screenshots live in product_update_images (a cropped screenshot is tens of
// KB), so there is nothing to redirect to and the response stays far below the function limit.
//
// ⚠️ A bad or missing image answers with a transparent pixel, never a 404 — the email is already in
// people's inboxes, and a broken-image box there cannot be taken back. Same rule as newsletter-media.

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { productUpdateImages } from '../../db/schema';
import { verifyImageSignature } from '../../src/utils/product-update-email';
import { withLambda } from '@netlify/aws-lambda-compat';

const PIXEL_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const pixel = () => ({
    statusCode: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=300' },
    body: PIXEL_B64,
    isBase64Encoded: true,
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, body: 'Method Not Allowed' };
    const id = Number(event.queryStringParameters?.i);
    const sig = String(event.queryStringParameters?.s || '');
    if (!Number.isInteger(id) || id <= 0 || !verifyImageSignature(id, sig)) return pixel();

    try {
        const [img] = await getDb().select({ mime: productUpdateImages.mime, dataB64: productUpdateImages.dataB64 })
            .from(productUpdateImages).where(eq(productUpdateImages.id, id)).limit(1);
        if (!img) return pixel();
        return {
            statusCode: 200,
            // Immutable: an image id is never re-used for different bytes.
            headers: { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' },
            body: img.dataB64,
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error('[product-update-image] lookup failed for image', id, err);
        return pixel();
    }
});
