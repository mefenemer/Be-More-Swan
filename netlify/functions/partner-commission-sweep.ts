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
import { saveTodaysFxRate, trueUpCommissions } from '../../src/utils/partner-costs-db';
import { purgeDeclinedApplications } from '../../src/utils/partner-erasure';
import { endDeclinedChanges, sweepPartnerActivity } from '../../src/utils/partner-activity';
import { isRegistrationLocked } from '../../src/utils/platform-config';

export async function sweepPartnerCommissions(): Promise<{ released: number; costs: { checked: number; waiting: number }; declinedApplicationsDeleted: number; activity: { paused: number; withdrawn: number; extended: number }; declinedChangesEnded: number }> {
    const db = getDb();
    const now = new Date();
    // Actual costs (Terms 3.2, docs/partner-actual-costs-plan.md): save the ECB rate, then work out every month that has
    // ended against its real costs — BEFORE releasing, so nothing becomes payable at the provisional figure.
    await saveTodaysFxRate(db);
    const costs = await trueUpCommissions(db, now);
    const { released } = await releaseDueCommissions(db, now);
    // privacy.html §9: declined applications without an account are deleted 12 months after the decision.
    const { deleted } = await purgeDeclinedApplications(db, now);
    // Partner Terms 1.3 §7.5: pause the activity clock (suspended / sign-ups paused), withdraw or extend notices.
    const activity = await sweepPartnerActivity(db, now, await isRegistrationLocked().catch(() => false));
    // Terms 8.1: not accepting the current version within 60 days of it taking effect = leaving, with the run-off.
    const { ended: declinedChangesEnded } = await endDeclinedChanges(db, now);
    return { released, costs, declinedApplicationsDeleted: deleted, activity, declinedChangesEnded };
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
