// src/utils/meta-app-block.ts
// Recognise a Meta APP-LEVEL block, as opposed to a broken connection.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// On 2026-09-02 every Meta connection in the product started failing at once with:
//
//     { "errorCode": 200, "httpStatus": 400, "errorMessage": "API access blocked." }
//
// Four connections, two organisations, both platforms, four DIFFERENT vault keys — including two
// that had not been touched since August. Nothing tenant-specific can produce that shape. It is
// Meta refusing the whole app, and no action a customer can take will clear it.
//
// Two things went wrong once that error arrived, and this module exists to stop both:
//
//   1. It classified as PERMANENT. `isRetryable` is false for a 400 with code 200, so every post
//      that came due during the outage was marked 'failed' on attempt 1 and never retried. A
//      platform outage was quietly consuming the customer's whole content calendar — and when the
//      block lifts, nothing republishes.
//   2. Code 200 is in post-failure-diagnosis's AUTH_CODES, so every one of those posts told the
//      customer "your connection has expired — reconnect". Reconnecting cannot succeed while the
//      app is blocked (the OAuth dialog is refused before consent), so the advice sent people into
//      a loop. Worse, a reconnect rebinds whichever Page Meta returns first — see meta-oauth's
//      account picker — so the "fix" we were recommending is itself hazardous.
//
// ⚠️ Deliberately matched on the MESSAGE, not on code 200 alone. Code 200 is Meta's generic
// "permission denied" and is genuinely returned when a single connection has lost a scope; making
// all of it retryable would hold real, actionable failures in limbo for ever. "API access blocked"
// is the specific string Meta uses for an app/user-level restriction.

/** Meta's wording for an app-level restriction. Lowercased before comparison. */
const APP_BLOCK_MARKERS = ['api access blocked'];

/**
 * Is this failure Meta refusing the APP, rather than this connection?
 *
 * Callers use it for two decisions that must agree: whether to hold the post instead of burning it
 * (the publishers) and whether to tell the customer to reconnect (the diagnosis). Keeping the test
 * in one place is what stops those two from drifting apart.
 */
export function isMetaAppBlocked(errorMessage: string | null | undefined): boolean {
    const m = String(errorMessage ?? '').toLowerCase();
    return APP_BLOCK_MARKERS.some(marker => m.includes(marker));
}

/** How long to hold posts before trying again. An app block is cleared by Meta, not by us. */
export const APP_BLOCK_HOLD_MS = 60 * 60 * 1000;

// ── Making the outage visible ───────────────────────────────────────────────────────────────────
// The hold above is the right behaviour and it is also completely silent: posts sit in 'scheduled',
// no post is marked failed, no per-post notification fires. That silence is deliberate — a
// platform-wide outage must not send every customer an alert per post — but left alone it means a
// Meta block looks exactly like a quiet week, and this codebase has been bitten repeatedly by
// failures whose only symptom was nothing happening.
//
// So the block gets one voice, aimed at the person who can act on it.
//
// ⚠️ The OPERATOR is alerted, not the customer — the same call check-optimiser-health makes, for
// the same reason. A customer can do nothing about a Meta app restriction; the founder can go and
// read App Dashboard → Alerts. The customer already has the honest per-post story, because
// post-failure-diagnosis reports a held post as "temporarily blocked … being held" rather than as
// a broken connection.

import { CONFIG_KEYS, getPlatformConfig, setPlatformConfig } from './platform-config';
import { sendEmail } from './email';

const FOUNDER_EMAIL = process.env.FOUNDER_ALERT_EMAIL || 'hello@bemoreswan.com';

/**
 * Don't re-send the same alarm every tick.
 *
 * ⚠️ The publishers run every ten minutes, so an unthrottled alert would be ~144 emails a day and
 * would be filtered within the hour. Six hours matches check-optimiser-health: an unattended
 * incident resurfaces within a working day without ever becoming noise.
 */
const ALERT_COOLDOWN_HOURS = 6;

/** Shape stored at META_APP_BLOCK_SINCE. `at` is when the block was FIRST seen, not last seen. */
interface BlockMarker { at: string; platform: string; }

function readMarker(v: unknown): BlockMarker | null {
    if (!v || typeof v !== 'object') return null;
    const at = (v as any).at;
    return typeof at === 'string' ? { at, platform: String((v as any).platform ?? 'meta') } : null;
}

/**
 * Record that Meta is refusing the app, and tell a human — at most once per cooldown.
 *
 * Best-effort by contract: this runs inside a publisher's failure path, and an alerting problem
 * must never become a publishing problem. Every fault is swallowed and logged.
 */
export async function recordMetaAppBlock(platform: string, now = new Date()): Promise<void> {
    try {
        const existing = readMarker(await getPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_SINCE));
        // First sighting wins: `at` answers "how long has this been going on", which is the one
        // question worth asking, and overwriting it every tick would make it always say "now".
        if (!existing) {
            await setPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_SINCE, { at: now.toISOString(), platform });
        }

        const lastAlert = await getPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_LAST_ALERT);
        const lastAt = typeof lastAlert === 'string' ? Date.parse(lastAlert) : NaN;
        if (Number.isFinite(lastAt) && now.getTime() - lastAt < ALERT_COOLDOWN_HOURS * 3_600_000) return;

        const since = existing?.at ?? now.toISOString();
        const hours = Math.round((now.getTime() - Date.parse(since)) / 3_600_000);
        await sendEmail({
            to: FOUNDER_EMAIL,
            subject: `Meta is blocking Be More Swan — Facebook and Instagram publishing is held`,
            html: `<p>Meta is refusing API access for the whole app, so <strong>no customer can publish to Facebook or Instagram</strong>.</p>
<p>First seen: <strong>${since}</strong>${hours >= 1 ? ` (about ${hours}h ago)` : ''}. Detected on: ${platform}.</p>
<p>Scheduled posts are being <strong>held</strong>, not failed — they will publish once access is restored, so nothing is lost. Note that held posts will all become due at once when it clears.</p>
<p>This is not something the code or a reconnect can fix. Confirm it with the app-token probe, then read <strong>App Dashboard &rarr; Alerts</strong>, which is the only place Meta states the reason.</p>`,
        });
        await setPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_LAST_ALERT, now.toISOString());
    } catch (err) {
        console.error('[meta-app-block] could not record/alert:', err instanceof Error ? err.message : err);
    }
}

/**
 * A Meta publish succeeded, so any block is over — drop the marker.
 *
 * ⚠️ This is what stops the row from lying. A marker that is only ever written says "blocked since
 * 2 September" for ever, and a stale marker is worse than none: it trains whoever reads it to
 * ignore the row. Clearing the alert stamp too means the NEXT block alerts immediately rather than
 * waiting out a cooldown left over from the last one.
 */
export async function clearMetaAppBlock(): Promise<void> {
    try {
        if (!(await getPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_SINCE))) return;   // common case: nothing to do
        await setPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_SINCE, null);
        await setPlatformConfig(CONFIG_KEYS.META_APP_BLOCK_LAST_ALERT, null);
    } catch (err) {
        console.error('[meta-app-block] could not clear the marker:', err instanceof Error ? err.message : err);
    }
}
