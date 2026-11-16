// netlify/functions/refresh-search-trends.ts
// The Google Trends engine's tick — scheduled HOURLY on PRODUCTION by netlify.toml
// ([functions.refresh-search-trends]). Wakes search-trends-background.ts when a DataForSEO task is
// waiting to be collected or a tracked term is a week old (src/utils/search-trends.ts). Hourly, not
// weekly: Standard tasks answer in 1–4 minutes, so the next tick collects what the last one posted.
// A tick with nothing due makes one small query and no provider call.
//
// Staging never fires Netlify schedules, so run-search-trends-refresh.ts wraps the same function for
// .github/workflows/staging-crons.yml.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { dispatchSearchTrends } from '../../src/utils/search-trends';

export default withLambda(async () => {
    try {
        const result = await dispatchSearchTrends(getDb(), resolveBaseUrl(), process.env.CRON_TRIGGER_SECRET);
        console.log('[refresh-search-trends]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[refresh-search-trends] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
