// netlify/functions/dispatch-ch-stream.ts
// Every 30 minutes on PRODUCTION (netlify.toml [functions.dispatch-ch-stream]): starts
// run-ch-stream-background.ts, which reads the Companies House filings and companies streams for the
// Watch list (buying triggers Phase 2). Does nothing until COMPANIES_HOUSE_STREAM_KEY is set (a separate
// "streaming" key from the Companies House developer hub, not the REST key), or with LEAD_WATCH_ENABLED=off.

import { withLambda } from '@netlify/aws-lambda-compat';
import { isLeadWatchEnabled, isStreamConfigured, startBackground } from '../../src/utils/lead-watch';

export default withLambda(async () => {
    if (!isStreamConfigured() || !isLeadWatchEnabled()) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: !isStreamConfigured() ? 'no_stream_key' : 'disabled' }) };
    }
    const result = await startBackground('run-ch-stream-background');
    console.log('[dispatch-ch-stream]', JSON.stringify(result));
    return { statusCode: result.started ? 200 : 500, body: JSON.stringify({ ok: result.started, ...result }) };
});
