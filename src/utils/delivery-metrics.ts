// src/utils/delivery-metrics.ts — Admin ▸ Dashboard: what we delivered (FR#29, owner 2026-11-14): issues resolved and
// feature requests released to live, all time and in the last 30 days.
//
//   Issues resolved   = an issue closed or marked fixed WITH a fix behind it (fixed_at — the fix went out, set by the
//                       live check or by hand — or resolved_at — closed as fixed). Issues closed because they moved
//                       to support, the roadmap or were duplicates have neither, so they don't count. Automatic
//                       incidents (no reporter) count too: they are real faults we fixed.
//   Released          = feature requests at 'released'; "last 30 days" by released_at (set when first released).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export interface DeliveryMetrics { issuesResolved: number; issuesResolved30d: number; featuresReleased: number; featuresReleased30d: number }

/** The SQL behind the two cards, exported so tests pin the definitions. */
export const ISSUES_RESOLVED_SQL = `status IN ('closed', 'fixed_ready_to_test') AND (fixed_at IS NOT NULL OR resolved_at IS NOT NULL)`;

export async function loadDeliveryMetrics(db: Db): Promise<DeliveryMetrics> {
    const [i] = await db.execute<{ total: number; recent: number }>(sql.raw(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE coalesce(fixed_at, resolved_at) > now() - interval '30 days')::int AS recent
          FROM issue_reports WHERE ${ISSUES_RESOLVED_SQL}`)) as unknown as Array<{ total: number; recent: number }>;
    const [f] = await db.execute<{ total: number; recent: number }>(sql.raw(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE released_at > now() - interval '30 days')::int AS recent
          FROM feature_requests WHERE status = 'released'`)) as unknown as Array<{ total: number; recent: number }>;
    return {
        issuesResolved: Number(i?.total) || 0, issuesResolved30d: Number(i?.recent) || 0,
        featuresReleased: Number(f?.total) || 0, featuresReleased30d: Number(f?.recent) || 0,
    };
}
