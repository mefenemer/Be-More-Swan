// netlify/functions/check-assistant-name.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Assistant names are unique per organisation — check within the active org.
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const name = event.queryStringParameters?.name;
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'Name parameter is required.' }) };

    try {
        // 2. Case-insensitive database check within the organisation (RLS-enforced)
        const existing = await withTenant(orgId, (tx) => tx.select().from(aiAssistants)
            .where(and(
                eq(aiAssistants.organisationId, orgId),
                sql`LOWER(${aiAssistants.name}) = LOWER(${name})`
            )).limit(1));

        return { statusCode: 200, body: JSON.stringify({ isUnique: existing.length === 0 }) };

    } catch (error) {
        console.error('Validation Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
});