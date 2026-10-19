// netlify/functions/partner-commission-sweep.ts
// Affiliate Partner Programme (docs/affiliate-partner-programme-plan.md §4.3): nightly, pending
// partner commissions whose holding period has ended become payable. Idempotent — a second run
// the same day finds nothing to release.
//
// Scheduled in netlify.toml (production only — Netlify never fires schedules on a branch deploy).
// Staging is poked through run-partner-sweep.ts from staging-crons.yml, so a failure is reported
// by an endpoint someone reads rather than vanishing into a scheduled-function log.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { releaseDueCommissions } from '../../src/utils/partner-ledger';
import { purgeDeclinedApplications } from '../../src/utils/partner-erasure';

export async function sweepPartnerCommissions(): Promise<{ released: number; declinedApplicationsDeleted: number }> {
    const db = getDb();
    const now = new Date();
    const { released } = await releaseDueCommissions(db, now);
    // privacy.html §9: declined applications without an account are deleted 12 months after the decision.
    const { deleted } = await purgeDeclinedApplications(db, now);
    return { released, declinedApplicationsDeleted: deleted };
}

export default withLambda(async () => {
    try {
        const result = await sweepPartnerCommissions();
        console.log('[partner-commission-sweep]', result);
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[partner-commission-sweep] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
