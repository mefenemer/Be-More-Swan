// netlify/functions/integration-audit.ts
// US-AUD-4.2.1 SC6/SC7: Integration API call audit log and enterprise CSV export.
//
//  GET ?format=json&from=&to=  → paginated JSON log (admin panel table)
//  GET ?format=csv&from=&to=   → SC7: CSV download for enterprise admins
import { HandlerEvent } from '@netlify/functions';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userOrganisations, integrationApiCalls, systemConnections } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    // Auth
    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();

    // Resolve org + check admin/owner role
    const [user] = await db
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, userId));
    if (!user?.organisationId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this account.' }) };
    }
    const orgId = user.organisationId;

    const [membership] = await db
        .select({ role: userOrganisations.role })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, orgId)))
        .limit(1);

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required.' }) };
    }

    const qs = event.queryStringParameters || {};
    const format = qs.format || 'json';
    const fromDate = qs.from ? new Date(qs.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // default 30d
    const toDate   = qs.to   ? new Date(qs.to)   : new Date();

    try {
        // Get all users in this org
        const orgMembers = await db
            .select({ userId: userOrganisations.userId })
            .from(userOrganisations)
            .where(eq(userOrganisations.organisationId, orgId));
        const memberIds = new Set(orgMembers.map(m => m.userId));

        // Fetch audit log rows for date range
        const rows = await db
            .select({
                id: integrationApiCalls.id,
                userId: integrationApiCalls.userId,
                integrationId: integrationApiCalls.integrationId,
                endpoint: integrationApiCalls.endpoint,
                httpStatus: integrationApiCalls.httpStatus,
                calledAt: integrationApiCalls.calledAt,
                serviceName: systemConnections.serviceName,
            })
            .from(integrationApiCalls)
            .leftJoin(systemConnections, eq(integrationApiCalls.integrationId, systemConnections.id))
            .where(and(
                gte(integrationApiCalls.calledAt, fromDate),
                lte(integrationApiCalls.calledAt, toDate)
            ))
            .orderBy(desc(integrationApiCalls.calledAt))
            .limit(10000);

        // Filter to org members only
        const orgRows = rows.filter(r => memberIds.has(r.userId));

        if (format === 'csv') {
            // SC7: Enterprise CSV export
            const header = 'id,userId,integrationId,serviceName,endpoint,httpStatus,calledAt\n';
            const csvRows = orgRows.map(r =>
                [
                    r.id,
                    r.userId,
                    r.integrationId ?? '',
                    `"${(r.serviceName || '').replace(/"/g, '""')}"`,
                    `"${r.endpoint.replace(/"/g, '""')}"`,
                    r.httpStatus ?? '',
                    r.calledAt.toISOString(),
                ].join(',')
            ).join('\n');

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'text/csv',
                    'Content-Disposition': `attachment; filename="integration-audit-${fromDate.toISOString().slice(0,10)}-to-${toDate.toISOString().slice(0,10)}.csv"`,
                },
                body: header + csvRows,
            };
        }

        // Default: JSON
        return {
            statusCode: 200,
            body: JSON.stringify({ total: orgRows.length, rows: orgRows }),
        };
    } catch (err) {
        console.error('integration-audit error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch audit log.' }) };
    }
});
