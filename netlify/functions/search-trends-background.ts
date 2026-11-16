// netlify/functions/search-trends-background.ts
// The Google Trends engine's worker (src/utils/search-trends.ts refreshSearchTrends): collects the
// DataForSEO answers that are ready, screens their related searches with Haiku, saves them, then posts
// a task for every tracked term that is a week old. Woken by refresh-search-trends.ts (hourly, prod)
// and run-search-trends-refresh.ts (staging). A background function because collecting and screening
// a few hundred terms can pass 26 s. Costs no customer task (docs/google-trends-plan.md §10 Q5).
//
// Without DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD it does nothing and says so.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { dataForSeoProvider } from '../../src/lib/trends-provider';
import { FILTER_MODEL, refreshSearchTrends } from '../../src/utils/search-trends';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend our DataForSEO balance.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[search-trends-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    const provider = dataForSeoProvider();
    if (!provider) {
        console.warn('[search-trends-background] DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set — nothing fetched.');
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Provider not configured.' }) };
    }

    try {
        const result = await refreshSearchTrends(getDb(), {
            provider,
            budgetMs: 12 * 60_000,
            callFilterModel: async (system, user) => (await gatewayGenerate({
                model: FILTER_MODEL,
                system,
                messages: [{ role: 'user', content: user }],
                maxTokens: 800,
                deadlineMs: 60_000,
                usage: { sessionId: 'search-trends-filter' },
            })).text,
        });
        console.log('[search-trends-background]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ done: true, ...result }) };
    } catch (err) {
        console.error('[search-trends-background] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
