// netlify/functions/claim-task-run.ts
// US-DB-1.5.1: Worker claims the next claimable task run using FOR UPDATE SKIP LOCKED.
// Two concurrent workers cannot claim the same row.
//
// POST /.netlify/functions/claim-task-run
//   Body: { workerId: string }   — identifies the worker/function instance
//   Auth: aura_session (or internal service token via X-Worker-Token header)
//
// Returns { claimed: boolean, taskRun?: TaskRun }

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { taskRuns } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';

const LEASE_MINUTES = 5;
const WORKER_SECRET = process.env.WORKER_SECRET; // shared secret for internal worker auth

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // Workers authenticate with a shared secret, not a user session
    const workerToken = event.headers['x-worker-token'];
    if (WORKER_SECRET && workerToken !== WORKER_SECRET) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid worker token.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const workerId = body.workerId?.trim();
    if (!workerId) return { statusCode: 400, body: JSON.stringify({ error: 'workerId is required.' }) };

    const db = getDb();

    // Atomic claim: FOR UPDATE SKIP LOCKED ensures two concurrent workers cannot
    // claim the same row. Expired leases (running but lease_expires_at < now())
    // are also claimable — this recovers from crashed workers.
    // The partial index task_runs_claimable_idx on (created_at) WHERE status='pending'
    // OR (status='running' AND lease_expires_at < now()) makes this O(claimable rows).
    const result = await db.execute(sql`
        UPDATE task_runs
        SET
            status           = 'running',
            locked_by        = ${workerId},
            locked_at        = now(),
            lease_expires_at = now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes',
            started_at       = COALESCE(started_at, now()),
            attempt_count    = attempt_count + 1
        WHERE id = (
            SELECT id FROM task_runs
            WHERE status = 'pending'
               OR (status = 'running' AND lease_expires_at < now())
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
    `);

    const row = result[0] as any;
    if (!row) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claimed: false }),
        };
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimed: true, taskRun: row }),
    };
});
