// netlify/functions/linkedin-ads-targeting.ts
// Typeahead against LinkedIn's own targeting vocabulary, so a user can pick where their ads run.
//
//   POST { action: 'search', facet: 'locations'|'jobFunctions'|'seniorities', query }
//     → { entities: [{ urn, name }], fallback?: true }
//
// ── Why this is a proxy and not a list we ship ──────────────────────────────────────────────────
// Targeting values are opaque URNs — `urn:li:geo:101165590` is the United Kingdom — and only
// LinkedIn can map one to a name. A hardcoded list goes stale silently, and a WRONG geo URN does
// not error: it targets somewhere else and spends the customer's money there. So the vocabulary is
// always read live, and the only two URNs in this codebase are documented fallbacks.
//
// ── It refuses rather than guessing ─────────────────────────────────────────────────────────────
// Gated on the same `paid_ads` feature and the same ads connection as everything else in the paid
// rails. If the typeahead itself fails we return the two verified fallback locations with
// `fallback: true` so the client can SAY that the list is limited — rather than an empty box that
// reads as "there is nowhere to advertise".

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import { assessAdsReadiness, getAdsConnection, getAdsToken } from '../../src/utils/linkedin-ads-connection';
import { COMPANY_SIZES, FALLBACK_GEOS, TARGETING_FACETS, searchTargeting } from '../../src/utils/ad-networks/linkedin';
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
    if (String(body.action || '') !== 'search') return json(400, { error: 'Unknown action.' });

    const facet = String(body.facet || 'locations');
    if (!(facet in TARGETING_FACETS)) return json(400, { error: 'Unknown targeting type.' });
    // Company sizes are a closed, documented enum with no lookup behind them — served straight
    // back rather than sent to a typeahead that would return nothing.
    if (facet === 'companySizes') return json(200, { entities: COMPANY_SIZES });

    const query = String(body.query || '').trim().slice(0, 80);
    if (query.length < 2) return json(200, { entities: [] });

    const readiness = assessAdsReadiness(await getAdsConnection(db, orgId));
    if (!readiness.ready) return json(400, { error: readiness.reason });
    const token = await getAdsToken(db, orgId);
    if (!token) return json(400, { error: 'The LinkedIn advertising connection needs reconnecting.' });

    try {
        const entities = await searchTargeting(
            token,
            readiness.connection.selectedAccountUrn!,
            facet as keyof typeof TARGETING_FACETS,
            query,
        );
        return json(200, { entities });
    } catch (err) {
        console.error('[linkedin-ads-targeting] typeahead failed', { facet }, err);
        // ⚠️ For LOCATIONS only. Falling back on a job title or a seniority would mean offering a
        // list we invented, and a wrong targeting URN spends money on the wrong audience without
        // erroring. An empty result for those is honest; a fabricated one is not.
        if (facet === 'locations') {
            return json(200, { entities: FALLBACK_GEOS, fallback: true });
        }
        return json(200, { entities: [], fallback: true });
    }
});
