// netlify/functions/check-dpa.ts
// US-GDPR-1.1.1: Check whether the authenticated user's organisation has accepted the DPA.
// GET /.netlify/functions/check-dpa
//   Returns { accepted, version, acceptedAt, currentVersion, upToDate, canAccept }
//   accepted  — some version still in DPA_VERSIONS_STILL_VALID is on record (work may continue)
//   upToDate  — the CURRENT version is on record (otherwise owners are asked to accept it)
//   canAccept — the caller may accept for the organisation (owner/admin); others are never prompted

import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { dpaAcceptances } from '../../db/schema';
import { CURRENT_DPA_VERSION, DPA_VERSIONS_STILL_VALID, DPA_ACCEPT_ROLES } from './accept-dpa';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const [latest] = await db
        .select({ version: dpaAcceptances.version, acceptedAt: dpaAcceptances.acceptedAt })
        .from(dpaAcceptances)
        .where(eq(dpaAcceptances.organisationId, ctx.organisationId))
        .orderBy(desc(dpaAcceptances.acceptedAt))
        .limit(1);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accepted: !!latest && DPA_VERSIONS_STILL_VALID.includes(latest.version),
            version: latest?.version ?? null,
            acceptedAt: latest?.acceptedAt ?? null,
            currentVersion: CURRENT_DPA_VERSION,
            upToDate: latest?.version === CURRENT_DPA_VERSION,
            canAccept: DPA_ACCEPT_ROLES.includes(ctx.role) && !ctx.impersonation,
        }),
    };
});
