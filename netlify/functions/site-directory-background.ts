// netlify/functions/site-directory-background.ts
// The site page directory's worker: reads a customer's external website into its directory
// (src/utils/site-directory-store.ts runDirectoryRefresh — sitemap or menu, robots.txt honoured, every
// fetch through safe-fetch.ts, headless Chrome for up to 5 thin pages). Woken by
// requestDirectoryRefresh (Business Information's "Re-read my site", the chat card, the weekly
// dispatch). A background function because 30 pages read one after another can pass 26 s.
// docs/site-directory-plan.md. Costs no task. runDirectoryRefresh never throws.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runDirectoryRefresh } from '../../src/utils/site-directory-store';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone make us crawl on a tenant's behalf.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[site-directory-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let organisationId = 0;
    try { organisationId = Number(JSON.parse(event.body || '{}').organisationId); } catch { /* handled below */ }
    if (!Number.isInteger(organisationId) || organisationId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'organisationId required.' }) };

    await runDirectoryRefresh(getDb(), organisationId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
