// netlify/functions/set-ai-digest.ts
// Epic 3 US8: set the org's AI approvals email-digest cadence.
//
// PATCH { frequency: 'off' | 'daily' | 'weekly' }  → { frequency }
//   Auth: aura_session cookie (org resolved server-side).

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const VALID = ['off', 'daily', 'weekly'];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'PATCH') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { frequency?: string };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const frequency = String(body.frequency || '');
    if (!VALID.includes(frequency)) {
        return { statusCode: 400, body: JSON.stringify({ error: `frequency must be one of: ${VALID.join(', ')}` }) };
    }

    await db.update(organisations).set({ aiDigestFrequency: frequency }).where(eq(organisations.id, ctx.organisationId));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frequency }) };
};
