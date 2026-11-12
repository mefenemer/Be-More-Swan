// src/utils/issue-screenshot-link.ts — a short-lived link to ONE issue's screenshot, for the AI fixer.
//
// The AI fix workflow (.github/workflows/ai-fix.yml) runs on GitHub and has no session. Screenshots
// live inline in issue_reports.image_data (a data URL of up to 5 MB), far too big for a
// workflow_dispatch input (65 KB in all). So the app passes this link instead and the workflow
// downloads the image into Claude's working copy (then deletes it before anything is committed).
//
//   <origin>/api/issue-screenshot?id=<issueId>&exp=<unix seconds>&t=<HMAC>
//
// The HMAC covers the id AND the expiry under the app's secret (same pattern as booking-links.ts),
// so a link opens one issue's screenshot for two hours and nothing else, and the id space can't be
// walked. netlify/functions/issue-screenshot.ts serves it. tests/issue-ai-fix-screenshot.test.ts.

import { createHmac, timingSafeEqual } from 'crypto';

/** Long enough for a queued run to start and Claude to finish (job timeout is 40 minutes). */
export const SCREENSHOT_LINK_TTL_SECS = 2 * 60 * 60;
export const SCREENSHOT_PATH = '/api/issue-screenshot';

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set — cannot sign screenshot links.');
    return s;
}

/** 32 hex characters: 128 bits. */
export function signScreenshot(issueId: number, exp: number, key = secret()): string {
    return createHmac('sha256', key).update(`issue-screenshot:${issueId}:${exp}`).digest('hex').slice(0, 32);
}

export function verifyScreenshotToken(issueId: number, exp: number, token: string, nowSecs = Math.floor(Date.now() / 1000), key?: string): boolean {
    if (!Number.isInteger(issueId) || issueId <= 0 || !Number.isInteger(exp) || exp < nowSecs) return false;
    // A link can't be minted for longer than the TTL, so a far-future exp is forged or a bug.
    if (exp > nowSecs + SCREENSHOT_LINK_TTL_SECS + 60) return false;
    let expected: Buffer;
    try { expected = Buffer.from(signScreenshot(issueId, exp, key ?? secret())); } catch { return false; }
    const given = Buffer.from(String(token || ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The link, or null when it can't be signed here (no secret, no origin). */
export function issueScreenshotUrl(origin: string | null | undefined, issueId: number, nowSecs = Math.floor(Date.now() / 1000), key?: string): string | null {
    if (!origin) return null;
    const exp = nowSecs + SCREENSHOT_LINK_TTL_SECS;
    try {
        return `${origin.replace(/\/+$/, '')}${SCREENSHOT_PATH}?id=${issueId}&exp=${exp}&t=${signScreenshot(issueId, exp, key ?? secret())}`;
    } catch { return null; }
}

/** The image types the Contact us form accepts, and the file extension the workflow saves them as. */
export const SCREENSHOT_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Split a stored data URL into its type and base64 body. Null for anything else. */
export function parseScreenshotDataUrl(data: string | null | undefined): { mime: string; b64: string } | null {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
    return m ? { mime: m[1], b64: m[2].replace(/\s+/g, '') } : null;
}
