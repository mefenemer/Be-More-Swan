// netlify/functions/linkedin-ads-account.ts
// The ad-account picker. Which of the member's LinkedIn ad accounts this workspace spends from.
//
//   POST { action: 'list' }                → { connected, ready, reason, accounts, selectedAccountUrn }
//   POST { action: 'select', accountUrn }  → { ok: true, selectedAccountUrn, currency }
//
// ── Why a selection step exists at all ──────────────────────────────────────────────────────────
// A LinkedIn member can have access to several ad accounts, including their employer's and their
// clients'. Defaulting to "the first one we found" would eventually charge somebody's agency for a
// campaign meant for their own business, and they would find out from an invoice. So nothing can be
// staged until a human has named the account, once, explicitly.
//
// ⚠️ THE SELECTION IS VALIDATED AGAINST THE STORED LIST. A caller cannot post an arbitrary account
// URN: even though the token would ultimately refuse an account it has no access to, that refusal
// arrives at SPEND time, deep in the staging flow, as an opaque LinkedIn error. Checking here means
// an unknown account is rejected immediately, in a sentence, by the only component that knows what
// "available" means.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import {
    ADS_SERVICE_NAME, assessAdsReadiness, getAdsConnection,
} from '../../src/utils/linkedin-ads-connection';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    // Same gate as the OAuth flow. A workspace without the entitlement should not be able to
    // inspect or change an ads connection even if one somehow exists.
    if (!await hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)) {
        return json(403, { error: 'Paid advertising is not available on this plan.' });
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    const connection = await getAdsConnection(db, orgId);

    if (action === 'list') {
        const readiness = assessAdsReadiness(connection);
        return json(200, {
            connected: !!connection,
            ready: readiness.ready,
            // The sentence, not a boolean. Each refusal leads somewhere different.
            reason: readiness.ready ? null : readiness.reason,
            // ⚠️ null and [] are passed through as they are. null means the listing failed;
            // [] means the member genuinely has no ad accounts. The client renders different
            // things, and flattening either would send someone to fix the wrong problem.
            accounts: connection?.adAccounts ?? null,
            selectedAccountUrn: connection?.selectedAccountUrn ?? null,
            selectedCurrency: connection?.selectedCurrency ?? null,
        });
    }

    if (action === 'select') {
        if (!connection) return json(404, { error: 'No LinkedIn advertising account is connected.' });
        const accountUrn = typeof body.accountUrn === 'string' ? body.accountUrn.trim() : '';
        if (!accountUrn) return json(400, { error: 'Which ad account should this workspace use?' });

        // ⚠️ The validation that keeps a stranger's account out of this workspace's metadata.
        const match = (connection.adAccounts ?? []).find((a) => a.urn === accountUrn);
        if (!match) {
            return json(400, {
                error: 'That ad account is not one of the accounts this connection can reach. Reconnect if the list looks out of date.',
            });
        }

        // Merge, never replace: the metadata blob also holds the discovered account list and the
        // tier, and overwriting it wholesale would lose both. The blog widget theme was replaced
        // wholesale once and silently deleted every key the caller did not resend.
        const [row] = await db.select({ metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.serviceName, ADS_SERVICE_NAME),
            ))
            .limit(1);
        const merged = { ...(row?.metadata as Record<string, unknown> ?? {}), selectedAccountUrn: accountUrn };

        await db.update(systemConnections)
            .set({ metadata: merged, updatedAt: new Date() })
            .where(and(
                eq(systemConnections.organisationId, orgId),
                // Scoped to the ads row. Never the posting connection.
                eq(systemConnections.serviceName, ADS_SERVICE_NAME),
            ));

        return json(200, { ok: true, selectedAccountUrn: accountUrn, currency: match.currency });
    }

    return json(400, { error: 'Unknown action.' });
});
