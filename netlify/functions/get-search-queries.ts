// netlify/functions/get-search-queries.ts
// GET → "Searches that found you" for the signed-in workspace: the top Google searches that showed its
// own site over the latest Search Console window (docs/google-trends-plan.md Phase 1b). Read-only; the
// daily ingest-gsc-metrics.ts writes the snapshot. Feeds Blog setup ▸ Search performance.
//
// Every member may read it: it is the workspace's own site performance, already summed by Google.

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { loadSearchQueries } from '../../src/utils/gsc-queries';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_LIMIT = 100;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const raw = parseInt(event.queryStringParameters?.limit || '', 10);
    const limit = Number.isNaN(raw) ? 25 : Math.min(MAX_LIMIT, Math.max(1, raw));

    try {
        const snap = await loadSearchQueries(db, ctx.organisationId, limit);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
            body: JSON.stringify(snap),
        };
    } catch (err) {
        console.error('[get-search-queries]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not read your searches.' }) };
    }
});
