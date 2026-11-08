// src/utils/worker-auth.ts
// The shared secret between our own functions and the background workers they start.
//
// WHY. process-asset-background and process-inspo-background took any POST from anyone. Asset ids
// are sequential, and the asset worker saves whatever it read — for a typed brand note (asset_type
// 'text', nothing to fetch) that was an empty string, marked 'ready'. One loop over ids could have
// wiped every workspace's brand notes (found 2026-11-08 while testing the PDF fix on staging).
// The other workers already used CRON_TRIGGER_SECRET as a Bearer token (draft-site-background.ts);
// this is that check, in one place.

import { timingSafeEqual } from 'node:crypto';

/** Headers for a call from one of our functions to a background worker. */
export function workerAuthHeaders(): Record<string, string> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    return secret
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }
        : { 'Content-Type': 'application/json' };
}

/**
 * Null when the caller sent the secret; otherwise the response to return. Fails CLOSED: with no
 * secret configured the worker refuses everything rather than running open.
 */
export function workerAuthError(headers: Record<string, string | undefined> | undefined, name: string): { statusCode: number; body: string } | null {
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn(`[${name}] CRON_TRIGGER_SECRET is not set — worker disabled.`);
        return { statusCode: 503, body: 'Worker not configured.' };
    }
    const raw = headers?.['authorization'] || headers?.['Authorization'] || '';
    const sent = Buffer.from(raw.replace(/^Bearer\s+/i, '').trim());
    const want = Buffer.from(secret);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return { statusCode: 401, body: 'Unauthorized.' };
    return null;
}
