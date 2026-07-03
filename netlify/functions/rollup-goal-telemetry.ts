// netlify/functions/rollup-goal-telemetry.ts
// SMART Goals — Feature 4 / AC4.2.2 Daily Rollups. Runs at 00:00 UTC and collapses the
// previous day's high-frequency telemetry (multiple poll/webhook points) into ONE close-of-day
// "Actual" point per goal, keeping the last value of the day. Prevents table bloat over a
// 12-month goal. Idempotent: a day already reduced to a single point is left untouched.
//
// One snapshot-consistent CTE: last_vals is computed from the pre-delete snapshot, del clears
// the day's rows, then a single 'rollup' row per goal is reinserted at 23:59:59 of that day.

import { Handler } from '@netlify/functions';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';

export const handler: Handler = async () => {
    const db = getDb();

    const result = await db.execute(sql`
        WITH bounds AS (
            SELECT date_trunc('day', now() - interval '1 day') AS s,
                   date_trunc('day', now())                    AS e
        ),
        dup AS (   -- only days with more than one point need collapsing
            SELECT gt.goal_id
            FROM goal_telemetry gt, bounds
            WHERE gt.recorded_at >= bounds.s AND gt.recorded_at < bounds.e
            GROUP BY gt.goal_id
            HAVING count(*) > 1
        ),
        last_vals AS (
            SELECT DISTINCT ON (gt.goal_id) gt.goal_id, gt.organisation_id, gt.metric_value
            FROM goal_telemetry gt, bounds
            WHERE gt.recorded_at >= bounds.s AND gt.recorded_at < bounds.e
              AND gt.goal_id IN (SELECT goal_id FROM dup)
            ORDER BY gt.goal_id, gt.recorded_at DESC
        ),
        del AS (
            DELETE FROM goal_telemetry gt USING bounds
            WHERE gt.recorded_at >= bounds.s AND gt.recorded_at < bounds.e
              AND gt.goal_id IN (SELECT goal_id FROM dup)
            RETURNING gt.goal_id
        )
        INSERT INTO goal_telemetry (goal_id, organisation_id, metric_value, source, recorded_at)
        SELECT lv.goal_id, lv.organisation_id, lv.metric_value, 'rollup',
               (SELECT e - interval '1 second' FROM bounds)
        FROM last_vals lv
        RETURNING goal_id;
    `);

    const rolledUp = Array.isArray(result) ? result.length : (result as any)?.rowCount ?? 0;
    return { statusCode: 200, body: JSON.stringify({ rolledUp }) };
};
