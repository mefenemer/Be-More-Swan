// netlify/functions/dispatch-site-audits.ts
// The Mystery Shopper's weekly check — scheduled daily on PRODUCTION by netlify.toml
// ([functions.dispatch-site-audits]). Queues today's due checks (src/utils/site-audit-schedule.ts);
// each one runs in run-site-audit-background.ts.
//
// Staging never fires Netlify schedules, so run-site-audit-dispatch.ts wraps the same function for
// .github/workflows/staging-crons.yml — and that wrapper returns the result, which is how a broken
// dispatch gets noticed rather than failing silently every morning (memory: nightly-sweeps-never-ran).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueSiteAudits } from '../../src/utils/site-audit-schedule';

export default withLambda(async () => {
    try {
        const result = await dispatchDueSiteAudits(getDb());
        // One line per tick, so a schedule that has silently stopped firing is visible in the log.
        console.log('[dispatch-site-audits]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[dispatch-site-audits] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
