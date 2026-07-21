// netlify/functions/refresh-workspace-tokens.ts
// Proactive OAuth token renewal for workspace_integrations connections — the store that
// holds the Google connectors (YouTube, Gmail, Search Console). Those refresh on demand at
// action time via getFreshAccessToken(), but a connection that sits idle would otherwise
// only ever be touched at the next use. This cron exercises the refresh grant ahead of
// expiry so:
//   • an idle connection's access token stays warm, and
//   • a dead/revoked refresh grant surfaces as status='expired' (→ "Reconnect needed" in
//     the UI) proactively, instead of failing the user's first publish after the lapse.
//
// getFreshAccessToken() owns all the hard parts (row lock, single-flight, rotating-token
// safety, persist, and marking the row 'expired' on a genuine rejection). We just pick the
// due connections and call it with a wide refresh window.
//
// Scheduled every 30 minutes (netlify.toml) — Google access tokens last ~1h, so a 40-min
// window refreshes them a run or two before they lapse. Add more providers to WINDOW_MS to
// bring their workspace connections under proactive refresh too.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, IntegrationError, type IntegrationProvider } from '../../src/utils/workspace-integrations';
import { withLambda } from '@netlify/aws-lambda-compat';

const CONCURRENCY = 25;

// How close to expiry (ms) before we proactively refresh, per provider. Only providers
// listed here are swept — omit a provider to leave it on pure on-demand refresh.
// All three below are Google OAuth: ~1h access tokens backed by an offline refresh token,
// so a 40-min window renews a run or two before they lapse.
const GOOGLE_WINDOW_MS = 40 * 60 * 1000;
const WINDOW_MS: Partial<Record<IntegrationProvider, number>> = {
    youtube: GOOGLE_WINDOW_MS,
    gmail: GOOGLE_WINDOW_MS,
    searchconsole: GOOGLE_WINDOW_MS,
};

export default withLambda(async () => {
    const db = getDb();

    const providers = Object.keys(WINDOW_MS) as IntegrationProvider[];
    if (!providers.length) return { statusCode: 200, body: 'no providers configured for proactive refresh' };

    const rows = await db
        .select({
            organisationId: workspaceIntegrations.organisationId,
            provider: workspaceIntegrations.provider,
            expiresAt: workspaceIntegrations.expiresAt,
        })
        .from(workspaceIntegrations)
        .where(and(
            inArray(workspaceIntegrations.provider, providers),
            eq(workspaceIntegrations.status, 'active'),
        ));

    const now = Date.now();
    const due = rows.filter((r) => {
        const window = WINDOW_MS[r.provider as IntegrationProvider];
        if (window == null) return false;
        // No expiry recorded → refresh to establish one.
        if (!r.expiresAt) return true;
        return new Date(r.expiresAt).getTime() - now < window;
    });

    if (!due.length) return { statusCode: 200, body: 'no workspace tokens due for refresh' };

    let refreshed = 0;
    let failed = 0;
    for (let i = 0; i < due.length; i += CONCURRENCY) {
        const chunk = due.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map((r) => {
            const provider = r.provider as IntegrationProvider;
            // Force renewal by treating anything inside this provider's window as due — the
            // wide skew is what makes getFreshAccessToken actually refresh (its default 60s
            // publish-path skew would let a still-valid token through untouched).
            return getFreshAccessToken(db, r.organisationId, provider, { refreshWithinMs: WINDOW_MS[provider] });
        }));
        for (let j = 0; j < results.length; j++) {
            const res = results[j];
            if (res.status === 'fulfilled') { refreshed++; continue; }
            failed++;
            const { organisationId, provider } = chunk[j];
            const err = res.reason;
            // getFreshAccessToken already flipped the row to 'expired' on a genuine rejection;
            // nothing to do here but record it. IntegrationError is the expected shape.
            const msg = err instanceof IntegrationError || err instanceof Error ? err.message : String(err);
            console.warn(`[refresh-workspace-tokens] org ${organisationId} (${provider}) refresh failed: ${msg}`);
        }
    }

    return { statusCode: 200, body: `workspace token refresh: ${refreshed} refreshed, ${failed} failed (of ${due.length} due)` };
});
