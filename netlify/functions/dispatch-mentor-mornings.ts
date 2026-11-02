// netlify/functions/dispatch-mentor-mornings.ts
// The Business Mentor's morning summary — scheduled HOURLY on PRODUCTION by netlify.toml
// ([functions.dispatch-mentor-mornings]). Each workspace is sent at 07:00 in its own time zone, so one
// hourly tick covers every zone (src/utils/mentor-morning.ts dispatchMornings). Built by rules: no model,
// no task.
//
// Staging never fires Netlify schedules, so run-mentor-morning-dispatch.ts wraps the same function for
// .github/workflows/staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchMornings } from '../../src/utils/mentor-morning';

export default withLambda(async () => {
    try {
        const result = await dispatchMornings(getDb());
        // One line per tick, so a schedule that has silently stopped firing is visible in the log.
        console.log('[dispatch-mentor-mornings]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[dispatch-mentor-mornings] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
