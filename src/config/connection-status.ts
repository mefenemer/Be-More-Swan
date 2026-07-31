// src/config/connection-status.ts
// Single source of truth for which system_connections.status values mean "this connection is
// broken and the user must reconnect".
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The status column has no CHECK constraint and its vocabulary grew per writer:
//
//   'active'                social-oauth-callback.ts, meta-oauth.ts, integrations.ts
//   'token_expired'         publish-instagram.ts, ingest-facebook-insights.ts,
//                           ingest-instagram-insights.ts   ← the Meta paths
//   'token_refresh_failed'  refresh-social-tokens.ts, refresh-meta-tokens.ts
//   'revoked'               revoke-connections.ts
//
// Every READER, meanwhile, was written against a guessed list — and each guess included 'expired'
// and 'failed', which nothing writes to this table, while omitting 'token_expired', which three
// writers do. A Meta connection that died therefore fell through every check at once:
//   • integration-health-check sent no in-app alert and no email
//   • the readiness "Attention Required" panel never appeared
//   • churn-detection never counted it
//   • integrations.js `_connHealth` rendered the card as **Connected**
// and the only visible symptom was the assistant quietly drafting for one platform fewer, because
// the drafting lookups (correctly) require status='active'.
//
// Ask here instead of writing another list. The browser's copy is generated into
// src/generated/platform-constants.js (scripts/gen-client-constants.ts) — do not retype it.

/** Every value system_connections.status is known to hold. */
export type ConnectionStatus =
    | 'active'
    | 'token_expired'
    | 'token_refresh_failed'
    | 'revoked'
    // Not written by any current code path, but present on older rows and cheap to keep honouring.
    | 'expired'
    | 'failed';

/**
 * Statuses meaning the credential no longer works. Anything that alerts, badges or diagnoses a
 * broken connection must use this list; anything deciding whether a connection can be USED should
 * test for 'active' instead, so a status nobody anticipated fails closed rather than open.
 */
export const DEAD_CONNECTION_STATUSES: ConnectionStatus[] = [
    'token_expired',
    'token_refresh_failed',
    'revoked',
    'expired',
    'failed',
];

export function isConnectionDead(status: string | null | undefined): boolean {
    return (DEAD_CONNECTION_STATUSES as string[]).includes(String(status ?? ''));
}
