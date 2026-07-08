// netlify/functions/get-run-audit-trail.ts
// US-GOV-4.2.2: Return the full event sequence for a specific agent run.
// GET /.netlify/functions/get-run-audit-trail?runId=N[&eventType=tool_call][&format=json|csv]
//   Auth: aura_session (workspace member — run must belong to same org as caller)

import { Handler, HandlerResponse } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, taskRuns, agentRunEvents, agentRunSummaries, userOrganisations } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

function toCsv(events: any[]): string {
    if (events.length === 0) return 'id,taskRunId,eventType,eventIndex,toolName,durationMs,costGbp,createdAt\n';
    const headers = ['id', 'taskRunId', 'eventType', 'eventIndex', 'toolName', 'durationMs', 'costGbp', 'createdAt'];
    const rows = events.map(e =>
        headers.map(h => {
            const v = e[h];
            if (v == null) return '';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
    );
    return [headers.join(','), ...rows].join('\n');
}

export default withLambda(async (event): Promise<HandlerResponse> => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const qs = event.queryStringParameters ?? {};
    const runId = parseInt(qs.runId || '');
    if (!runId) return { statusCode: 400, body: JSON.stringify({ error: 'runId is required.' }) };

    const db = getDb();

    // Load caller's org
    const [caller] = await db.select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);

    // Load run — must belong to the caller's org (or the caller directly)
    const [run] = await db.select({ id: taskRuns.id, organisationId: taskRuns.organisationId, userId: taskRuns.userId })
        .from(taskRuns).where(eq(taskRuns.id, runId)).limit(1);

    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };

    const isOwner = run.userId === userId;
    const inSameOrg = caller?.organisationId && run.organisationId === caller.organisationId;
    if (!isOwner && !inSameOrg) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
    }

    // Build query
    const conditions: any[] = [eq(agentRunEvents.taskRunId, runId)];
    if (qs.eventType) conditions.push(eq(agentRunEvents.eventType, qs.eventType));

    const events = await db.select().from(agentRunEvents)
        .where(and(...conditions))
        .orderBy(asc(agentRunEvents.eventIndex));

    // Load summary if available
    const [summary] = await db.select().from(agentRunSummaries)
        .where(eq(agentRunSummaries.taskRunId, runId)).limit(1);

    const format = qs.format?.toLowerCase();

    if (format === 'csv') {
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="run-${runId}-audit-trail.csv"`,
            },
            body: toCsv(events),
        };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, events, summary: summary ?? null, total: events.length }),
    };
});
