// src/utils/system-map-data.ts — loads everything the System Map shows (docs/system-map-plan.md).
// One loader for the page (admin-system-map.ts) and the Systems chat (admin-systems-chat.ts), so the
// GUI and the chat never disagree. The maths is in system-map.ts (pure, tested).

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { systemStatus } from './system-registry';
import { assembleSystemMap, type FixedCostRow, type UsageRow } from './system-map';

type Db = ReturnType<typeof getDb>;
const DEFAULT_FX = { USD: 0.787, EUR: 0.853, AUD: 0.512, CAD: 0.574 };   // same fallback as the COGS report

async function rows<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
    return [...await db.execute(q)] as unknown as T[];
}
// A missing table (an environment without the SQL yet) reads as empty rather than failing the page.
async function safe<T>(p: Promise<T[]>, label: string): Promise<T[]> {
    try { return await p; } catch (err) { console.warn(`[system-map] ${label} unavailable:`, err instanceof Error ? err.message : err); return []; }
}

export async function loadSystemMap(db: Db, hostHeader: string | null | undefined, now = new Date()) {
    const [status, usage, roles, chosen, fixed, tasks, fxRow, pg, names] = await Promise.all([
        systemStatus(hostHeader),
        safe(rows<{ model: string; usd_all: string; usd_30: string; calls_30: number; calls_all: number; first_at: string | null }>(db, sql`
            SELECT model,
                   coalesce(sum(cost_usd::numeric), 0)::text AS usd_all,
                   coalesce(sum(cost_usd::numeric) FILTER (WHERE created_at > now() - interval '30 days'), 0)::text AS usd_30,
                   (count(*) FILTER (WHERE created_at > now() - interval '30 days'))::int AS calls_30,
                   count(*)::int AS calls_all,
                   min(created_at)::text AS first_at
            FROM ai_usage_log GROUP BY model`), 'ai_usage_log'),
        safe(rows<{ model: string; roles: string[] }>(db, sql`
            SELECT l.model, array_agg(DISTINCT m.role_key) AS roles
            FROM ai_usage_log l
            JOIN ai_assistants a ON a.id = l.assistant_id
            JOIN master_assistants m ON m.id = a.master_assistant_id
            WHERE l.created_at > now() - interval '30 days'
            GROUP BY l.model`), 'roles by model'),
        safe(rows<{ role_key: string; model: string }>(db, sql`SELECT role_key, model FROM assistant_model_settings`), 'assistant_model_settings'),
        safe(rows<{ id: number; system_key: string; label: string; amount_monthly: string; currency: string; started_on: string; ended_on: string | null; note: string }>(db, sql`
            SELECT id, system_key, label, amount_monthly::text, currency, started_on::text, ended_on::text, note
            FROM system_fixed_costs ORDER BY system_key, started_on`), 'system_fixed_costs'),
        safe(rows<{ all_units: number; units_30: number; first_at: string | null }>(db, sql`
            SELECT coalesce(sum(units), 0)::int AS all_units,
                   coalesce(sum(units) FILTER (WHERE created_at > now() - interval '30 days'), 0)::int AS units_30,
                   min(created_at)::text AS first_at
            FROM task_ledger WHERE source = 'work'`), 'task_ledger'),
        safe(rows<{ value: Record<string, number> }>(db, sql`SELECT value FROM platform_config WHERE key = 'fx_rates_to_gbp' LIMIT 1`), 'fx rates'),
        safe(rows<{ v: string }>(db, sql`SELECT current_setting('server_version') AS v`), 'postgres version'),
        safe(rows<{ role_key: string; name: string }>(db, sql`SELECT role_key, name FROM master_assistants`), 'assistant names'),
    ]);

    // Neon reports its Postgres version live — the one system whose version we can read, not state.
    const services = status.services.map((s) => s.key === 'neon' && pg[0]?.v
        ? { ...s, version: { ...(s.version ?? {}), api: `PostgreSQL ${pg[0].v}` } }
        : s);

    const map = assembleSystemMap({
        status: { ...status, services },
        usage: usage.map((u): UsageRow => ({ model: u.model, usdAll: Number(u.usd_all), usd30: Number(u.usd_30), calls30: u.calls_30, callsAll: u.calls_all, firstAt: u.first_at })),
        rolesByModel30: Object.fromEntries(roles.map((r) => [r.model, r.roles ?? []])),
        configuredRoleModels: Object.fromEntries(chosen.map((c) => [c.role_key, c.model])),
        fixed: fixed.map((f): FixedCostRow => ({ id: f.id, systemKey: f.system_key, label: f.label, amountMonthly: Number(f.amount_monthly), currency: f.currency, startedOn: f.started_on, endedOn: f.ended_on, note: f.note })),
        tasks: { all: tasks[0]?.all_units ?? 0, d30: tasks[0]?.units_30 ?? 0, firstAt: tasks[0]?.first_at ?? null },
        fx: fxRow[0]?.value && typeof fxRow[0].value === 'object' ? { ...DEFAULT_FX, ...fxRow[0].value } : DEFAULT_FX,
        fxFromConfig: !!fxRow[0]?.value,
        now,
    });
    // Role keys → assistant names, so the page and chat say "Blog Assistant", not "blog".
    return { ...map, roleNames: Object.fromEntries(names.map((n) => [n.role_key, n.name])) as Record<string, string> };
}
