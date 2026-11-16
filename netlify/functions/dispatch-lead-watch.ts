// netlify/functions/dispatch-lead-watch.ts
// The Watch list's daily check (buying triggers Phase 2) — scheduled on PRODUCTION by netlify.toml
// ([functions.dispatch-lead-watch], 05:10 UTC, after the FSA poll's Companies House matching). Starts
// run-lead-watch-background.ts. Staging uses run-lead-watch-dispatch.ts from staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { startBackground } from '../../src/utils/lead-watch';

export default withLambda(async () => {
    const result = await startBackground('run-lead-watch-background');
    console.log('[dispatch-lead-watch]', JSON.stringify(result));
    return { statusCode: result.started ? 200 : 500, body: JSON.stringify({ ok: result.started, ...result }) };
});
