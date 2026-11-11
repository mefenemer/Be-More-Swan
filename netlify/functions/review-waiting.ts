// netlify/functions/review-waiting.ts
// GET → { groups: [{ key, assistantId, assistantName, label, tab, count, items: [{ id, title, at }] }], total }
// Everything waiting on the user that the Review page does not list itself (src/utils/review-waiting.ts).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { loadReviewWaiting } from '../../src/utils/review-waiting';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const body = await loadReviewWaiting(db, ctx.organisationId);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
});
