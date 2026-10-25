// netlify/functions/mentor-job-background.ts
// The Business Mentor's worker: one research job or one strategy draft (src/utils/mentor-jobs.ts,
// runMentorJob). Woken by mentor.ts through triggerMentorJob the moment the user asks — from the Plan
// tab or from a chat card.
//
// A background function because a grounded search takes ~2 minutes (docs/business-mentor-plan.md §1.1
// point 5) and the platform kills a synchronous function at 26 s with NO body. runMentorJob never throws
// and always ends the job; a job this worker never reaches is ended (free) by the stale sweep.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMentorJob } from '../../src/utils/mentor-jobs';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a workspace's tasks and paid searches.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[mentor-job-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let jobId = 0;
    try { jobId = Number(JSON.parse(event.body || '{}').jobId); } catch { /* handled below */ }
    if (!Number.isInteger(jobId) || jobId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'jobId required.' }) };

    await runMentorJob(getDb(), jobId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
