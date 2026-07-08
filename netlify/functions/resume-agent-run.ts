// netlify/functions/resume-agent-run.ts
// US-GOV-4.2.1: Manual resume of a suspended agent run — requires explicit acknowledgement.
// POST /.netlify/functions/resume-agent-run
//   Body: { taskRunId: number, anomalyId: number, acknowledgement: string }
//   Auth: aura_session cookie (run owner)
//
// Returns { resumed: boolean }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { taskRuns, agentAnomalies } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
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

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { taskRunId, anomalyId, acknowledgement } = body;
    if (!taskRunId || !anomalyId || !acknowledgement?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId, anomalyId, and acknowledgement are required.' }) };
    }

    const db = getDb();

    const [run] = await db.select({ id: taskRuns.id, status: taskRuns.status })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, userId)))
        .limit(1);

    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };
    if (run.status !== 'suspended') {
        return {
            statusCode: 409,
            body: JSON.stringify({ error: `Run is in '${run.status}' state — only suspended runs can be resumed.` }),
        };
    }

    const [anomaly] = await db.select({ id: agentAnomalies.id, status: agentAnomalies.status, anomalyType: agentAnomalies.anomalyType })
        .from(agentAnomalies)
        .where(and(eq(agentAnomalies.id, anomalyId), eq(agentAnomalies.taskRunId, taskRunId)))
        .limit(1);

    if (!anomaly) return { statusCode: 404, body: JSON.stringify({ error: 'Anomaly record not found.' }) };
    if (anomaly.status !== 'suspended') {
        return { statusCode: 409, body: JSON.stringify({ error: 'Anomaly is not in suspended state.' }) };
    }

    const now = new Date();

    await db.update(taskRuns)
        .set({ status: 'completed' }) // restore to runnable state; execution layer re-drives
        .where(eq(taskRuns.id, taskRunId));

    await db.update(agentAnomalies)
        .set({
            status: 'resumed',
            resumedAt: now,
            resumedBy: userId,
            resumeAcknowledgement: acknowledgement.trim(),
        })
        .where(eq(agentAnomalies.id, anomalyId));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumed: true, taskRunId, anomalyId, resumedAt: now.toISOString() }),
    };
});
