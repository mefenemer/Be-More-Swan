// netlify/functions/get-calendar-activity.ts (#3)
// GET ?from=<iso>&to=<iso> → completed assistant task runs in the range, so the calendar
// can show how busy each assistant has been (alongside scheduled posts). Tenant-scoped.
//
// Returns: { activities: [{ id, assistantId, taskType, status, at }] }  (at = completedAt ?? createdAt)
// (Distinct from get-assistant-activity.ts, which is the per-assistant audit feed on the detail page.)

import { Handler } from '@netlify/functions';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { taskRuns } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    // Date window (defaults to the current month when not supplied).
    const now = new Date();
    const fromParam = event.queryStringParameters?.from;
    const toParam = event.queryStringParameters?.to;
    const from = fromParam ? new Date(fromParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = toParam ? new Date(toParam) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return json(400, { error: 'Invalid from/to date.' });

    try {
        // Completed runs in the window. createdAt is indexed (task_runs_org_created_idx) and is
        // always set; completedAt is preferred for display when present.
        const rows = await db.select({
            id: taskRuns.id,
            assistantId: taskRuns.assistantId,
            taskType: taskRuns.taskType,
            status: taskRuns.status,
            completedAt: taskRuns.completedAt,
            createdAt: taskRuns.createdAt,
        }).from(taskRuns).where(and(
            eq(taskRuns.organisationId, orgId),
            eq(taskRuns.status, 'completed'),
            gte(taskRuns.createdAt, from),
            lte(taskRuns.createdAt, to),
        ));

        const activities = rows.map(r => ({
            id: r.id,
            assistantId: r.assistantId,
            taskType: r.taskType,
            status: r.status,
            at: (r.completedAt ?? r.createdAt) as Date,
        }));

        return json(200, { activities });
    } catch (err: any) {
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) return json(200, { activities: [] });
        console.error('[get-calendar-activity]', err);
        return json(500, { error: 'Failed to load assistant activity.' });
    }
};
