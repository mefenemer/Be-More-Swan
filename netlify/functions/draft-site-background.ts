// netlify/functions/draft-site-background.ts
// The Website Assistant's draft worker: writes a whole site with the model (src/utils/site-store.ts
// runSiteDraft), or — with `import: true` — reads their current site into a draft for review
// (src/utils/site-import-store.ts runSiteImport). Woken by sites.ts `draft` through triggerSiteDraft. A background function because a
// whole site is one long model call — past the 26 s a synchronous function gets (memory:
// blog-ai-draft-never-worked-in-prod). runSiteDraft never throws and always ends the draft.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runSiteDraft } from '../../src/utils/site-store';
import { runSiteImport } from '../../src/utils/site-import-store';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a tenant's tasks.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[draft-site-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let siteId = 0;
    let request: string | null = null;
    let isImport = false;
    try {
        const b = JSON.parse(event.body || '{}');
        siteId = Number(b.siteId);
        request = typeof b.request === 'string' ? b.request : null;
        isImport = b.import === true;
    } catch { /* handled below */ }
    if (!Number.isInteger(siteId) || siteId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'siteId required.' }) };

    if (isImport) await runSiteImport(getDb(), siteId);
    else await runSiteDraft(getDb(), siteId, request);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
