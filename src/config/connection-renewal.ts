// src/config/connection-renewal.ts
// Which system_connections services keep themselves alive, and which already warn about their own
// expiry. Two readers need the same answer and used to carry it separately:
//   • integrations.ts — sets `autoRefresh` so the card hides the "Expiring in Nd" countdown.
//   • integration-health-check.ts — skips its "expires in N days" alert, which would otherwise fire
//     on a healthy token every day (an X token always expires within 2 hours).
//
// tests/connection-autorefresh.test.ts checks CRON_RENEWED_SERVICES against what the refresh crons
// actually select, in both directions.

/** Renewed silently by a cron: x → refresh-social-tokens.ts, facebook/instagram → refresh-meta-tokens.ts. */
export const CRON_RENEWED_SERVICES: readonly string[] = ['x', 'facebook', 'instagram'];

/**
 * Selected by refresh-social-tokens.ts but NOT renewable: LinkedIn issues our app no refresh token
 * (only "Share on LinkedIn" + "Sign In" are approved), so each connection dies at 60 days. The cron
 * sends its own 7-day warning and condemns it at expiry (handleNoRefreshTokenExpiry), so the health
 * check must not send a second "expiring" alert. It is NOT auto-refreshing: the card counts down.
 */
export const CRON_WARNS_OWN_EXPIRY: readonly string[] = ['linkedin'];
