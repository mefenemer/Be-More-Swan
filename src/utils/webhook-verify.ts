// webhook-verify.ts — provider signature verification for inbound webhooks.
// Pure crypto over the RAW request body (never the re-serialised JSON) so signatures
// match byte-for-byte. Constant-time comparison; replay protection where the provider
// supplies a timestamp. Add new providers here as trigger-style connectors land.

import { createHmac, timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

// Slack: signature = 'v0=' + HMAC_SHA256(signingSecret, `v0:${timestamp}:${rawBody}`).
// Reject requests older than `toleranceSec` (default 5 min) to defeat replay.
export function verifySlackSignature(opts: {
    signingSecret: string | undefined;
    timestamp: string | undefined;   // X-Slack-Request-Timestamp (unix seconds)
    signature: string | undefined;   // X-Slack-Signature
    rawBody: string;
    toleranceSec?: number;
    nowSec?: number;                  // injectable for tests
}): boolean {
    const { signingSecret, timestamp, signature, rawBody } = opts;
    if (!signingSecret || !timestamp || !signature) return false;
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const tolerance = opts.toleranceSec ?? 300;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;
    const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
    return safeEqual(expected, signature);
}

// Zendesk: signature = base64(HMAC_SHA256(secret, `${timestamp}${rawBody}`)),
// header X-Zendesk-Webhook-Signature with X-Zendesk-Webhook-Signature-Timestamp.
export function verifyZendeskSignature(opts: {
    secret: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
    rawBody: string;
}): boolean {
    const { secret, timestamp, signature, rawBody } = opts;
    if (!secret || !signature) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp ?? ''}${rawBody}`).digest('base64');
    return safeEqual(expected, signature);
}

// Svix (used by Resend for delivery events, and by several other providers).
// signature = base64(HMAC_SHA256(secretBytes, `${svixId}.${svixTimestamp}.${rawBody}`)), where
// secretBytes is the base64 payload AFTER the `whsec_` prefix — hashing the prefixed string is the
// classic mistake and produces a signature that never matches.
//
// The `svix-signature` header carries a SPACE-SEPARATED list of `v1,<sig>` entries, because a
// secret being rotated means two valid signatures for a window. Matching only the first would
// reject perfectly good deliveries for the length of every rotation.
export function verifySvixSignature(opts: {
    secret: string | undefined;       // whsec_…
    id: string | undefined;           // svix-id
    timestamp: string | undefined;    // svix-timestamp (unix seconds)
    signature: string | undefined;    // svix-signature
    rawBody: string;
    toleranceSec?: number;
    nowSec?: number;                  // injectable for tests
}): boolean {
    const { secret, id, timestamp, signature, rawBody } = opts;
    if (!secret || !id || !timestamp || !signature) return false;

    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const tolerance = opts.toleranceSec ?? 300;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    if (!key.length) return false;

    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');

    for (const part of signature.split(' ')) {
        const [version, value] = part.split(',');
        if (version !== 'v1' || !value) continue;
        if (safeEqual(expected, value)) return true;
    }
    return false;
}
