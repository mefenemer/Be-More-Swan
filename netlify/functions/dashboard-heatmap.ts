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
// User-scoped via the aura_session cookie, mirroring roi-stats.ts.

import { HandlerEvent } from '@netlify/functions';
import { sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };

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

    // Trailing window — clamp to a sane range (default 8 weeks)
    const weeks = Math.min(Math.max(parseInt(event.queryStringParameters?.weeks || '8', 10) || 8, 1), 26);

    const db = getDb();

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
                WHERE user_id = ${userId}
                  AND status = 'completed'
                  AND COALESCE(completed_at, created_at) >= NOW() - (${weeks} * INTERVAL '1 week')
                UNION ALL
                SELECT created_at AS ts
                FROM scheduled_posts
                WHERE user_id = ${userId}
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
