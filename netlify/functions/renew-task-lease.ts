// netlify/functions/renew-task-lease.ts
// US-DB-1.5.1: Worker renews its lease on a running task run to prevent expiry.
// Called periodically (e.g. every 3 min) while the run is in progress.
//
// POST /.netlify/functions/renew-task-lease
//   Headers: X-Worker-Token
//   Body: { taskRunId: number, workerId: string }
//
// Returns { renewed: boolean, leaseExpiresAt: string }

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { taskRuns } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const WORKER_SECRET  = process.env.WORKER_SECRET;
const LEASE_MINUTES  = 5;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const workerToken = event.headers['x-worker-token'];
    if (WORKER_SECRET && workerToken !== WORKER_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid worker token.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { taskRunId, workerId } = body;
    if (!taskRunId || !workerId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId and workerId required.' }) };
    }

    const db = getDb();
    const leaseExpiresAt = new Date(Date.now() + LEASE_MINUTES * 60 * 1000);

    const result = await db.update(taskRuns)
        .set({ leaseExpiresAt })
        .where(and(
            eq(taskRuns.id, taskRunId),
            eq(taskRuns.lockedBy, workerId),
            eq(taskRuns.status, 'running'),
        ))
        .returning({ id: taskRuns.id });

    if (!result.length) {
        return { statusCode: 409, body: JSON.stringify({ error: 'Run not found, not owned by this worker, or not in running state.' }) };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renewed: true, leaseExpiresAt: leaseExpiresAt.toISOString() }),
    };
});
