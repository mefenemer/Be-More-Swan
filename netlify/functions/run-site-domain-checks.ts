// netlify/functions/run-site-domain-checks.ts
// On-demand HTTP trigger for the 10-minute own-domain recheck (check-site-domains.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy, so staging never
// fires check-site-domains. .github/workflows/staging-crons.yml pokes this instead.
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`; refuses to run when unset (fail closed).
//
// POST /.netlify/functions/run-site-domain-checks → 200 { ok: true, checked, live, failed }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runSiteDomainChecks } from './check-site-domains';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-site-domain-checks] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runSiteDomainChecks();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-site-domain-checks]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
