// netlify/functions/check-site-domains.ts — scheduled every 10 minutes (netlify.toml).
//
// Moves every customer domain that is on its way (src/utils/site-domains.ts checkDueDomains) on as far
// as it will go, so nobody has to keep pressing "Check now": DNS that has just propagated is picked
// up, a certificate that has just been issued is noticed, and the owner is emailed once it's live.
// Before this, a domain only moved when the owner pressed the button (Restorative Futures, 2026-11-13).
//
// ⚠️ Netlify fires scheduled functions ONLY on the production deploy. Staging is a branch deploy, so
// .github/workflows/staging-crons.yml pokes run-site-domain-checks, which calls the same function.

import { withLambda } from '@netlify/aws-lambda-compat';
import { purgeCache } from '@netlify/functions';
import { getDb } from '../../db/client';
import { checkDueDomains, notifyDomainLive } from '../../src/utils/site-domains';
import { siteCacheTag } from '../../src/utils/site-hosting';

export async function runSiteDomainChecks() {
    const db = getDb();
    return checkDueDomains(db, async (row, slug) => {
        // The bemoreswan.site address starts redirecting now, not after the 60-second cache.
        if (slug) { try { await purgeCache({ tags: [siteCacheTag(slug)] }); } catch (err) { console.error('[check-site-domains] cache purge failed', err); } }
        await notifyDomainLive(db, row.siteId, row.domain);
    });
}

export default withLambda(async () => {
    try {
        const result = await runSiteDomainChecks();
        if (result.checked) console.log('[check-site-domains]', JSON.stringify(result));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[check-site-domains]', err);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
