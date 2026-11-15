// netlify/functions/dispatch-trigger-polls.ts
// Buying triggers' daily poll — scheduled on PRODUCTION by netlify.toml ([functions.dispatch-trigger-polls]).
// Starts run-trigger-poll-background.ts, which reads every council's FSA "Awaiting Inspection" list
// and records the new entries (src/utils/trigger-engine.ts). Admin only in Phase 1.
//
// Staging never fires Netlify schedules, so run-trigger-poll-dispatch.ts wraps the same start for
// .github/workflows/staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { startTriggerPoll } from '../../src/utils/trigger-engine';

export default withLambda(async () => {
    const result = await startTriggerPoll();
    // One line per tick, so a schedule that has silently stopped firing is visible in the log.
    console.log('[dispatch-trigger-polls]', JSON.stringify(result));
    return { statusCode: result.started ? 200 : 500, body: JSON.stringify({ ok: result.started, ...result }) };
});
