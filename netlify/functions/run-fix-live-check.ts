// netlify/functions/run-fix-live-check.ts
// On-demand HTTP trigger for the Issues live check + auto-close (see check-fixes-live.ts and
// src/utils/issue-fix-live.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy. Staging is a
// branch deploy, so `check-fixes-live` never fires there, and a staging reporter would never hear
// their fix is live on staging. .github/workflows/staging-crons.yml pokes this instead — the same
// pattern as run-campaign-reconciler.ts.
//
// AUTH: shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses to run (fail
// closed). Callers pass `Authorization: Bearer <secret>`. The check itself trusts no input: the
// deployed commit is baked in at build and inclusion is GitHub's answer.
//
// POST /.netlify/functions/run-fix-live-check
//   → 200 { ok: true, checked, live, notYet, errors, autoClosed, skipped? }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runFixesLiveCheck } from './check-fixes-live';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-fix-live-check] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runFixesLiveCheck();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-fix-live-check]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
