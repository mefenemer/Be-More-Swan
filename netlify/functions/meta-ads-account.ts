// netlify/functions/meta-ads-account.ts
// The Meta ad-account and Page picker. Mirrors linkedin-ads-account.ts.
//
//   POST { action: 'list' }                              → state, accounts, pages, selections
//   POST { action: 'select', accountId?, pageId? }       → { ok, selectedAccountId, selectedPageId, currency }
//
// Nothing defaults to "the first account we found": a login can reach an employer's or a client's
// ad account, and guessing would one day charge the wrong business. Both choices are validated
// against the lists stored at connect time — an arbitrary id is refused here, in a sentence, rather
// than at spend time as an opaque Meta error.
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import {
    META_ADS_SERVICE_NAME, assessMetaAdsReadiness, getMetaAdsConnection, metaAdsCreateProblem,
} from '../../src/utils/meta-ads-connection';
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

    if (!await hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)) {
        return json(403, { error: 'Paid advertising is not available on this plan.' });
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');
    const connection = await getMetaAdsConnection(db, orgId);

    if (action === 'list') {
        const readiness = assessMetaAdsReadiness(connection);
        const createProblem = readiness.ready ? metaAdsCreateProblem(connection) : null;
        return json(200, {
            connected: !!connection,
            ready: readiness.ready && !createProblem,
            reason: readiness.ready ? createProblem : readiness.reason,
            accounts: connection?.adAccounts ?? null,
            pages: connection?.pages ?? null,
            selectedAccountId: connection?.selectedAccountId ?? null,
            selectedPageId: connection?.selectedPageId ?? null,
            selectedCurrency: connection?.selectedCurrency ?? null,
        });
    }

    if (action === 'select') {
        if (!connection) return json(404, { error: 'No Meta advertising account is connected.' });
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
        const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';
        if (!accountId && !pageId) return json(400, { error: 'Which ad account or Page should this workspace use?' });

        const account = accountId ? (connection.adAccounts ?? []).find((a) => a.id === accountId) : null;
        if (accountId && !account) {
            return json(400, { error: 'That ad account is not one this connection can reach. Reconnect if the list looks out of date.' });
        }
        const page = pageId ? (connection.pages ?? []).find((p) => p.id === pageId) : null;
        if (pageId && !page) {
            return json(400, { error: 'That Page is not one this connection manages. Reconnect if the list looks out of date.' });
        }

        // Merge, never replace — the blob also holds both discovered lists.
        const [row] = await db.select({ metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, orgId), eq(systemConnections.serviceName, META_ADS_SERVICE_NAME)))
            .limit(1);
        const merged: Record<string, unknown> = { ...(row?.metadata as Record<string, unknown> ?? {}) };
        if (account) merged.selectedAccountId = account.id;
        if (page) merged.selectedPageId = page.id;

        await db.update(systemConnections)
            .set({ metadata: merged, updatedAt: new Date() })
            .where(and(eq(systemConnections.organisationId, orgId), eq(systemConnections.serviceName, META_ADS_SERVICE_NAME)));

        return json(200, {
            ok: true,
            selectedAccountId: (merged.selectedAccountId as string) ?? null,
            selectedPageId: (merged.selectedPageId as string) ?? null,
            currency: account?.currency ?? connection.selectedCurrency,
        });
    }

    return json(400, { error: 'Unknown action.' });
});
