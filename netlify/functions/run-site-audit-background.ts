// netlify/functions/run-site-audit-background.ts
// The Mystery Shopper's worker: one check of a site (src/utils/site-audit.ts, executeAuditRun).
// Woken by site-audits.ts through triggerSiteAudit the moment the user asks, and (plan step 4) by
// the weekly schedule.
//
// A background function, because a check reads up to ten pages and makes up to four model calls —
// well past the 26 s a synchronous function gets, and the platform's kill at 26 s returns NO body
// (memory: blog-ai-draft-never-worked-in-prod).
//
// executeAuditRun never throws and always ends the run. If this worker is never reached at all, the
// stuck-run sweep in site-audits.ts ends the run, free.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { executeAuditRun } from '../../src/utils/site-audit';
import { looksLikeEmail, normaliseEmail } from '../../src/utils/audience-contacts';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a tenant's tasks.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-site-audit-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let runId = 0;
    let emailTo: string | null = null;
    try {
        const b = JSON.parse(event.body || '{}');
        runId = Number(b.runId);
        // The public taster's address — used once to send the result, never stored (site-taster.ts).
        if (typeof b.emailTo === 'string' && looksLikeEmail(normaliseEmail(b.emailTo))) emailTo = normaliseEmail(b.emailTo);
    } catch { /* handled below */ }
    if (!Number.isInteger(runId) || runId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'runId required.' }) };
    }

    await executeAuditRun(getDb(), runId, { emailTo });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
