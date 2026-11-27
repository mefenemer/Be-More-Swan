// The Note Taker's bot on Zoom (docs/note-taker-bot-plan.md step 4; docs/zoom-marketplace-review-pack.md).
//
// Since March 2026 Zoom lets a bot into a meeting on someone else's account only "on behalf of" (OBF) a Zoom user who
// authorised OUR Zoom app and who is in that meeting. So:
//   1. the workspace connects Zoom once (workspace_integrations provider 'zoom', oauth-integrations.ts), granting
//      `user:read:token` (mint OBF tokens) and `user:read:user` (who is connected);
//   2. each Zoom bot's Recall request carries `zoom.obf_token_url`: a URL of ours, signed per bot (obfTokenUrl);
//   3. when the bot joins, Recall GETs that URL and we answer with a fresh OBF token for that one meeting
//      (netlify/functions/zoom-obf-token.ts → fetchObfToken: GET /v2/users/me/token?type=onbehalf&meeting_id=…),
//      as plain text (Recall reads newline-separated tokens and tries them in order);
//   4. if the connected person is not in the call, Recall waits (waiting_room_timeout), then fails with
//      `zoom_obf_user_not_in_meeting`.
// When the user removes our app in Zoom, Zoom calls zoom-deauthorize.ts (signed with ZOOM_WEBHOOK_SECRET_TOKEN) and the
// connection is deleted. Everything here sits behind the meeting_bot_zoom flag until Zoom's Marketplace review passes.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The scopes the connect must come back with (set on the Zoom app; Zoom's authorize URL takes none). */
export const ZOOM_REQUIRED_SCOPES = ['user:read:token', 'user:read:user'] as const;

/** Every required scope is in Zoom's space- or comma-separated `scope` string. Pure. */
export function zoomScopesGranted(scope: unknown): boolean {
    const got = new Set(String(scope ?? '').split(/[\s,]+/).filter(Boolean));
    return ZOOM_REQUIRED_SCOPES.every((s) => got.has(s));
}

/**
 * The numeric meeting number in a Zoom join link (/j/123…, /w/123…, /wc/join/123… — the forms cleanMeetingLink accepts), or null — a personal
 * link (/my/name) has no number, and an OBF token is minted for one meeting number. Pure.
 */
export function zoomMeetingNumber(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (host !== 'zoom.us' && !host.endsWith('.zoom.us')) return null;
    const m = u.pathname.match(/^\/(?:j|w|wc\/join)\/(\d{9,12})(?:\/|$)/i);
    return m ? m[1] : null;
}

// ── The signed token URL Recall calls ────────────────────────────────────────────────────────────

const OBF_SIG_LABEL = 'bms-zoom-obf-v1:';

/** The per-bot signature: HMAC-SHA256 over the bot id with the key, hex. Pure. */
export function obfSignature(key: string, botRowId: number): string {
    return createHmac('sha256', key).update(OBF_SIG_LABEL + String(botRowId)).digest('hex');
}

/** The URL Recall GETs for the OBF token of one bot. Pure. */
export function obfTokenUrl(baseUrl: string, botRowId: number, key: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/.netlify/functions/zoom-obf-token?bot=${botRowId}&sig=${obfSignature(key, botRowId)}`;
}

/** The bot id from a signed token URL's query, or null when the signature is wrong. Pure. */
export function verifyObfQuery(key: string, bot: unknown, sig: unknown): number | null {
    if (!key || typeof bot !== 'string' || !/^\d{1,12}$/.test(bot) || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const id = Number(bot);
    const want = Buffer.from(obfSignature(key, id), 'hex');
    const got = Buffer.from(sig, 'hex');
    return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

/** The signing key: kept apart from the client secret by its label, so no new secret has to be set. */
export function obfKey(): string {
    return process.env.ZOOM_CLIENT_SECRET || '';
}

/** The statuses in which a bot may still be let into its call (Recall retries the URL while it waits). */
export const OBF_STATUSES: readonly string[] = ['scheduled', 'joining', 'waiting_room', 'in_call'];

/**
 * Whether a token may be minted for this bot now: a Zoom bot still on its way in (or in the call), from 15 minutes
 * before its join time until 12 hours after it. A finished, cancelled or long-past bot gets nothing. Pure.
 */
export function obfTokenAllowed(bot: { platform: string; status: string; joinAt: Date }, now: Date): boolean {
    if (bot.platform !== 'zoom' || !OBF_STATUSES.includes(bot.status)) return false;
    const t = bot.joinAt.getTime();
    return now.getTime() >= t - 15 * 60 * 1000 && now.getTime() <= t + 12 * 60 * 60 * 1000;
}

// ── Zoom's API ───────────────────────────────────────────────────────────────────────────────────

export class ZoomError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}

async function zoomGet(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
        const res = await fetchImpl(`https://api.zoom.us/v2/${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
        // Never the body or the token in the message: only the status and Zoom's numeric code.
        if (!res.ok) {
            const j = await res.json().catch(() => ({})) as { code?: unknown };
            throw new ZoomError(res.status, `Zoom ${res.status}${typeof j.code === 'number' ? ` code ${j.code}` : ''}`);
        }
        return await res.json() as Record<string, unknown>;
    } finally {
        clearTimeout(timer);
    }
}

/** A fresh OBF token for one meeting, from the connected user's access token. */
export async function fetchObfToken(accessToken: string, meetingNumber: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    const j = await zoomGet(`users/me/token?type=onbehalf&meeting_id=${encodeURIComponent(meetingNumber)}`, accessToken, fetchImpl);
    if (typeof j.token !== 'string' || !j.token) throw new ZoomError(502, 'Zoom returned no token');
    return j.token;
}

/** Who is connected: Zoom's user id (kept as tenantId, matched on deauthorization) and email (the card's label). */
export async function fetchZoomUser(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; email: string | null }> {
    const j = await zoomGet('users/me', accessToken, fetchImpl);
    if (typeof j.id !== 'string' || !j.id) throw new ZoomError(502, 'Zoom returned no user id');
    return { id: j.id, email: typeof j.email === 'string' ? j.email.slice(0, 254) : null };
}

// ── Zoom's webhook (deauthorization) ─────────────────────────────────────────────────────────────

/**
 * Zoom's signature check (x-zm-signature = "v0=" + HMAC-SHA256(secret token, "v0:{x-zm-request-timestamp}:{raw body}")),
 * with a five-minute window so a captured request can't be replayed. Pure.
 */
export function verifyZoomWebhook(secretToken: string, headers: Record<string, string | undefined>, rawBody: string, now: Date = new Date()): boolean {
    const ts = headers['x-zm-request-timestamp'];
    const sig = headers['x-zm-signature'];
    if (!secretToken || !ts || !sig || !/^\d{9,11}$/.test(ts)) return false;
    if (Math.abs(now.getTime() - Number(ts) * 1000) > 5 * 60 * 1000) return false;
    const want = Buffer.from(`v0=${createHmac('sha256', secretToken).update(`v0:${ts}:${rawBody}`).digest('hex')}`);
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
}

/** The answer to Zoom's endpoint.url_validation challenge. Pure. */
export function zoomUrlValidation(secretToken: string, plainToken: string): { plainToken: string; encryptedToken: string } {
    return { plainToken, encryptedToken: createHmac('sha256', secretToken).update(plainToken).digest('hex') };
}
