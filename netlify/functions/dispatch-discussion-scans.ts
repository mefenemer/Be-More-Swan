// netlify/functions/dispatch-discussion-scans.ts
// The Discussions tab's daily scan — scheduled on PRODUCTION by netlify.toml
// ([functions.dispatch-discussion-scans]). Starts every enabled watch not scanned in the last 18
// hours (src/utils/discussions.ts dispatchDueScans); each runs in run-discussion-scan-background.ts.
//
// Staging never fires Netlify schedules, so run-discussion-scan-dispatch.ts wraps the same function
// for .github/workflows/staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueScans } from '../../src/utils/discussions';

export default withLambda(async () => {
    try {
        const result = await dispatchDueScans(getDb());
        // One line per tick, so a schedule that has silently stopped firing is visible in the log.
        console.log('[dispatch-discussion-scans]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[dispatch-discussion-scans] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
