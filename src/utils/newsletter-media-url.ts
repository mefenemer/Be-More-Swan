// src/utils/newsletter-media-url.ts
// A durable, public, unguessable URL for an image inside a sent newsletter.
//
// ⚠️ WHY NOT THE URL WE ALREADY HAVE. Everywhere else in the product an asset resolves through
// resolveAssetDisplayUrl(), which presigns an R2 object — a URL that expires in minutes. That is
// correct for a page someone is looking at now and catastrophic for an email: a newsletter sits in
// an inbox for years, and every picture in it would be a broken box by the following morning. The
// blog widget solves the same problem by leaving media src-less and injecting a fresh URL at read
// time; an email has no read-time hook, so the src must be a URL that stays valid.
//
// ⚠️ WHY IT IS SIGNED RATHER THAN JUST /media?asset=123. A recipient's mail client fetches this with
// no session, so the route cannot be authenticated — which makes a bare id an enumeration of every
// image in every tenant's library. The signature is an HMAC of the asset id under the app's own
// secret: unguessable, stable forever (so a re-render produces the same URL and mail clients keep
// their cache), and cheap to verify with no extra table.
//
// The token is NOT a capability we hand out lightly: it is minted only for an asset a tenant has
// deliberately placed in an email that is about to be sent to strangers, which is the one case
// where the image is already leaving the building.

import { createHmac, timingSafeEqual } from 'crypto';

/** Same secret the rest of the app signs with. Absent in a test process — see requireSecret. */
function requireSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set — cannot sign newsletter media URLs.');
    return secret;
}

/** 16 hex characters: 64 bits of unguessability, short enough not to bloat every <img>. */
export function signAssetId(assetId: number, secret = requireSecret()): string {
    return createHmac('sha256', secret).update(`newsletter-media:${assetId}`).digest('hex').slice(0, 16);
}

export function verifyAssetSignature(assetId: number, signature: string, secret = requireSecret()): boolean {
    const expected = Buffer.from(signAssetId(assetId, secret));
    const given = Buffer.from(String(signature || ''));
    // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The `<img src>` that goes in the email.
 *
 * `baseUrl` is the app's own origin (src/utils/base-url.ts). ⚠️ It must be absolute: a relative src
 * in an email resolves against nothing and shows as a broken image in every client.
 */
export function newsletterMediaUrl(baseUrl: string, assetId: number, secret?: string): string {
    const sig = signAssetId(assetId, secret);
    return `${String(baseUrl).replace(/\/$/, '')}/api/newsletter/media?a=${assetId}&s=${sig}`;
}
