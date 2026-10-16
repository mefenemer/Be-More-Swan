// netlify/functions/get-usage-summary.ts
// Group C / Request 0.2: the Billing "Usage & Credits" panel.
// GET → {
//   media:   { balance, held, monthly },          // AI image/video credit pool (rolls over)
//   x:       { used, allowance, bonus, remaining },// X posting allowance (resets monthly, +purchased bonus)
//   byAssistant: [ { assistantId, name, media, x } ] // current-month spend per assistant
// }
//
// Per-assistant attribution splits current-month debits from ai_credit_ledger two ways:
//   • media — via job_id → media_generation_jobs.assistant_id (stamped on every assistant-driven job)
//   • X     — via ai_credit_ledger.assistant_id (stamped at settle; X debits carry no job)
// Genuinely manual (user-initiated) spend has no assistant and is returned under assistantId=null so
// the panel can show an honest "Unattributed" row rather than silently dropping it.
//
// Single task allowance ('unified_task_metering', docs/task-metering.md) → instead {
//   unit: 'tasks',
//   tasks: { used, limit, bonus, inFlight, remaining },
//   byKind: [ { kind, label, units } ],                 // this month, from task_ledger
//   byAssistant: [ { assistantId, name, tasks } ]
// }

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getBalance, monthlyAllowance, getXUsage } from '../../src/utils/ai-credits';
import { getTaskUsage } from '../../src/utils/work-metering';
import { isUnifiedTaskMetering } from '../../src/utils/task-metering-flag';
import { getPeriodStart } from '../../src/utils/atomic-cap-check';
import { WORK_KIND_LABELS, type WorkKind } from '../../src/config/task-weights';
import { sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    if (await isUnifiedTaskMetering(orgId)) return taskSummary(db, orgId);

    const [{ balance, held }, monthly, x] = await Promise.all([
        getBalance(db, orgId),
        monthlyAllowance(db, orgId),
        getXUsage(db, orgId),
    ]);

    // Current-month spend per assistant. Two rollups (media via job join, X via column), merged in JS.
    // date_trunc('month', now()) is UTC on Neon, matching the monthly reset the X allowance uses.
    const mediaRows = await db.execute<{ assistant_id: number | null; credits: number }>(sql`
        SELECT j.assistant_id AS assistant_id, SUM(-l.delta)::int AS credits
        FROM ai_credit_ledger l
        JOIN media_generation_jobs j ON j.id = l.job_id
        WHERE l.organisation_id = ${orgId}
          AND l.delta < 0
          AND l.reason IN ('image_generation', 'video_generation')
          AND l.created_at >= date_trunc('month', now())
        GROUP BY j.assistant_id
    `);
    const xRows = await db.execute<{ assistant_id: number | null; credits: number }>(sql`
        SELECT assistant_id, SUM(-delta)::int AS credits
        FROM ai_credit_ledger
        WHERE organisation_id = ${orgId}
          AND delta < 0
          AND reason IN ('x_post_text', 'x_post_link')
          AND created_at >= date_trunc('month', now())
        GROUP BY assistant_id
    `);

    // Merge the two rollups keyed by assistant id (null → 'unattributed' bucket).
    const merged = new Map<number | null, { media: number; x: number }>();
    const bump = (id: number | null, field: 'media' | 'x', n: number) => {
        const row = merged.get(id) ?? { media: 0, x: 0 };
        row[field] += n;
        merged.set(id, row);
    };
    for (const r of mediaRows) bump(r.assistant_id, 'media', r.credits);
    for (const r of xRows) bump(r.assistant_id, 'x', r.credits);

    // Resolve names for the real assistant ids present.
    const ids = [...merged.keys()].filter((k): k is number => k != null);
    const names = new Map<number, string>();
    if (ids.length) {
        const nameRows = await db.execute<{ id: number; name: string | null }>(sql`
            SELECT id, name FROM ai_assistants WHERE id IN (${sql.join(ids, sql`, `)})
        `);
        for (const r of nameRows) names.set(r.id, r.name || `Assistant #${r.id}`);
    }

    const byAssistant = [...merged.entries()]
        .map(([id, v]) => ({
            assistantId: id,
            name: id == null ? 'Unattributed' : (names.get(id) || `Assistant #${id}`),
            media: v.media,
            x: v.x,
        }))
        // Busiest first; the unattributed bucket sinks to the bottom regardless of size.
        .sort((a, b) => {
            if (a.assistantId == null) return 1;
            if (b.assistantId == null) return -1;
            return (b.media + b.x) - (a.media + a.x);
        });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            media: { balance, held, monthly },
            x: { used: x.used, allowance: x.allowance, bonus: x.bonus, remaining: x.remaining },
            byAssistant,
        }),
    };
});

async function taskSummary(db: ReturnType<typeof getDb>, orgId: number) {
    const period = getPeriodStart().toISOString();
    const [usage, kindRows, assistantRows] = await Promise.all([
        getTaskUsage(db, orgId),
        db.execute<{ kind: string; units: number }>(sql`
            SELECT kind, SUM(units)::int AS units FROM task_ledger
             WHERE organisation_id = ${orgId} AND period_start = ${period} AND source = 'work'
             GROUP BY kind ORDER BY units DESC`),
        db.execute<{ assistant_id: number | null; name: string | null; units: number }>(sql`
            SELECT l.assistant_id, a.name, SUM(l.units)::int AS units FROM task_ledger l
              LEFT JOIN ai_assistants a ON a.id = l.assistant_id
             WHERE l.organisation_id = ${orgId} AND l.period_start = ${period} AND l.source = 'work'
             GROUP BY l.assistant_id, a.name`),
    ]);
    const byKind = (kindRows as unknown as Array<{ kind: string; units: number }>).map(r => ({
        kind: r.kind,
        label: WORK_KIND_LABELS[r.kind as WorkKind] ?? r.kind,
        units: Number(r.units),
    }));
    const byAssistant = (assistantRows as unknown as Array<{ assistant_id: number | null; name: string | null; units: number }>)
        .map(r => ({
            assistantId: r.assistant_id,
            name: r.assistant_id == null ? 'Unattributed' : (r.name || `Assistant #${r.assistant_id}`),
            tasks: Number(r.units),
        }))
        .sort((a, b) => {
            if (a.assistantId == null) return 1;
            if (b.assistantId == null) return -1;
            return b.tasks - a.tasks;
        });
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            unit: 'tasks',
            tasks: { used: usage.used, limit: usage.limit, bonus: usage.bonus, inFlight: usage.inFlight, remaining: usage.remaining },
            byKind,
            byAssistant,
        }),
    };
}
