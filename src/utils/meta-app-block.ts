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
