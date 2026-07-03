// netlify/functions/dashboard-heatmap.ts
// US-DASH-1 (AC3): Activity heatmap — proves the assistant works 24/7 in the background.
//
//  GET ?weeks=8
//   → { grid: number[7][24], maxCount, totalTasks, peak: { dow, hour, count } | null,
//       weeks, tz }
//
// grid[dayOfWeek][hour] = count of completed work (task_runs + scheduled_posts)
// that landed in that weekday/hour bucket over the trailing window.
// dayOfWeek: 0=Sun … 6=Sat (Postgres DOW).
// Org-scoped via requireTenant, mirroring roi-stats.ts — activity is org-wide
// (created by any teammate or by an assistant acting on the org's behalf), not
// limited to the viewer's own userId (issue #90: today's teammate/assistant
// activity was invisible on this widget because it filtered by user_id).

import { HandlerEvent } from '@netlify/functions';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;

    // Trailing window — clamp to a sane range (default 8 weeks)
    const weeks = Math.min(Math.max(parseInt(event.queryStringParameters?.weeks || '8', 10) || 8, 1), 26);

    // Empty 7×24 grid
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

    try {
        // Bucket completed work by weekday × hour over the window. EXTRACT(DOW)
        // returns 0=Sun … 6=Sat. Two sources feed "work completed": the generic
        // task_runs governance queue (completedAt, falling back to createdAt), and
        // scheduled_posts — the table the live content pipeline (SMM draft/publish
        // flow) actually writes to. Without the latter this heatmap stayed empty for
        // every org whose only activity is content drafting/publishing (issue #57),
        // even though roi-stats.ts / get-time-saved.ts already count scheduled_posts
        // as completed work for the "Hours Saved" / "Tasks Handled" tiles above it.
        const rows = await db.execute(sql`
            WITH activity AS (
                SELECT COALESCE(completed_at, created_at) AS ts
                FROM task_runs
                WHERE organisation_id = ${organisationId}
                  AND status = 'completed'
                  AND COALESCE(completed_at, created_at) >= NOW() - (${weeks} * INTERVAL '1 week')
                UNION ALL
                SELECT created_at AS ts
                FROM scheduled_posts
                WHERE organisation_id = ${organisationId}
                  AND created_at >= NOW() - (${weeks} * INTERVAL '1 week')
            )
            SELECT
                EXTRACT(DOW  FROM ts)::int AS dow,
                EXTRACT(HOUR FROM ts)::int AS hour,
                COUNT(*)::int AS cnt
            FROM activity
            GROUP BY 1, 2
        `);

        let maxCount = 0;
        let totalTasks = 0;
        let peak: { dow: number; hour: number; count: number } | null = null;

        for (const r of rows as unknown as Array<{ dow: number; hour: number; cnt: number }>) {
            const dow = Number(r.dow);
            const hour = Number(r.hour);
            const cnt = Number(r.cnt);
            if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
            grid[dow][hour] = cnt;
            totalTasks += cnt;
            if (cnt > maxCount) maxCount = cnt;
            if (!peak || cnt > peak.count) peak = { dow, hour, count: cnt };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grid, maxCount, totalTasks, peak, weeks, tz: 'UTC' }),
        };
    } catch (err: any) {
        const msg: string = err?.message || '';
        // Table not yet provisioned in this environment → empty heatmap, not a 500.
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return { statusCode: 200, body: JSON.stringify({ grid, maxCount: 0, totalTasks: 0, peak: null, weeks, tz: 'UTC' }) };
        }
        console.error('dashboard-heatmap error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to compute activity heatmap.' }) };
    }
};
