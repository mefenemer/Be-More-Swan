// netlify/functions/admin-triggers.ts
// Admin ▸ Assistants ▸ Buying triggers (docs/buying-triggers-plan.md §5 Phase 1, FR#36): what the
// trigger engine has seen, so the owner can measure volume and reachability BEFORE any customer sees a
// trigger (§9.3 gate). Admin only. Nothing here is shown to a workspace.
//
//   GET ?days=7|30|90&area=&trade=  → { setUp, source, stock, totals, perDay, byArea, byTrade, measures, events, areas, trades }
//   POST { action: 'run_now' }      → starts run-trigger-poll-background (minutes); the page reloads later
//
// Until db/z-trigger-events.sql is applied every read answers { setUp: false } and the page says so.
// Gated on `platform_config`.

import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { startTriggerPoll, isCorporateCompanyType, CORPORATE_COMPANY_TYPES } from '../../src/utils/trigger-engine';
import { FSA_SOURCE, isFsaSourceEnabled, fhrsLabel } from '../../src/lib/triggers/fsa-fhrs';
import { isCompaniesHouseConfigured } from '../../src/lib/companies-house';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: userId } : null;
}

function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

const n = (v: unknown) => Number(v ?? 0) || 0;

async function overview(q: Record<string, string | undefined>) {
    const db = getDb();
    const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
    const area = (q.area || '').trim().slice(0, 120) || null;
    const trade = (q.trade || '').trim().slice(0, 120) || null;
    // The filters, as one fragment used by every query below.
    const where = sql`source = ${FSA_SOURCE} AND first_seen_at >= now() - make_interval(days => ${days})
        ${area ? sql`AND area = ${area}` : sql``} ${trade ? sql`AND ${trade} = ANY(trade_codes)` : sql``}`;

    const [src] = await db.execute(sql`
        SELECT to_char(baseline_done_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS baseline_done_at,
               to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_run_at,
               to_char(last_ok_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_ok_at, last_result
        FROM trigger_sources WHERE source = ${FSA_SOURCE}`) as Array<{ baseline_done_at: string | null; last_run_at: string | null; last_ok_at: string | null; last_result: Record<string, unknown> | null }>;
    const [stock] = await db.execute(sql`
        SELECT count(*) AS listed, count(*) FILTER (WHERE last_seen_at >= now() - interval '2 days') AS current
        FROM trigger_seen WHERE source = ${FSA_SOURCE}`) as Array<{ listed: string; current: string }>;

    const [m] = await db.execute(sql`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE (payload ->> 'hasAddress')::boolean) AS has_address,
               count(*) FILTER (WHERE (payload ->> 'nameLooksCorporate')::boolean) AS name_corporate,
               count(*) FILTER (WHERE company_checked_at IS NOT NULL) AS checked,
               count(*) FILTER (WHERE company_number IS NOT NULL) AS matched,
               count(*) FILTER (WHERE company_type = ANY(${CORPORATE_SQL_LIST}::text[])) AS corporate,
               count(*) FILTER (WHERE (payload ->> 'hasAddress')::boolean OR company_number IS NOT NULL) AS reachable
        FROM trigger_events WHERE ${where}`) as Array<Record<string, string>>;

    const perDay = await db.execute(sql`
        SELECT occurred_on::text AS day, count(*) AS count FROM trigger_events WHERE ${where}
        GROUP BY occurred_on ORDER BY occurred_on`) as Array<{ day: string; count: string }>;

    const byArea = await db.execute(sql`
        SELECT area, count(*) AS count,
               count(*) FILTER (WHERE (payload ->> 'hasAddress')::boolean OR company_number IS NOT NULL) AS reachable,
               count(*) FILTER (WHERE company_type = ANY(${CORPORATE_SQL_LIST}::text[])) AS corporate
        FROM trigger_events WHERE ${where} GROUP BY area ORDER BY count(*) DESC, area LIMIT 40`) as Array<Record<string, string>>;

    const byTrade = await db.execute(sql`
        SELECT payload ->> 'businessType' AS label, trade_codes[1] AS code, count(*) AS count,
               count(*) FILTER (WHERE (payload ->> 'hasAddress')::boolean OR company_number IS NOT NULL) AS reachable,
               count(*) FILTER (WHERE company_type = ANY(${CORPORATE_SQL_LIST}::text[])) AS corporate
        FROM trigger_events WHERE ${where} GROUP BY 1, 2 ORDER BY count(*) DESC`) as Array<Record<string, string>>;

    const events = await db.execute(sql`
        SELECT id, subject_id, name, postcode, area, trade_codes, occurred_on::text AS occurred_on, payload,
               company_number, company_type, company_matched_by, company_checked_at IS NOT NULL AS company_checked
        FROM trigger_events WHERE ${where} ORDER BY first_seen_at DESC, id DESC LIMIT 200`) as Array<Record<string, any>>;

    // Filter choices: every council and kind seen in the last 90 days, whatever the current filter.
    const areas = await db.execute(sql`
        SELECT DISTINCT area FROM trigger_events WHERE source = ${FSA_SOURCE} AND area IS NOT NULL ORDER BY area`) as Array<{ area: string }>;
    const trades = await db.execute(sql`
        SELECT DISTINCT trade_codes[1] AS code, payload ->> 'businessType' AS label FROM trigger_events
        WHERE source = ${FSA_SOURCE} ORDER BY 2`) as Array<{ code: string; label: string | null }>;

    const lastResult = { ...(src?.last_result || {}) };
    delete (lastResult as Record<string, unknown>).state;

    // Phase 2: the Watch list, across every workspace. Its own catch: db/z-lead-watch.sql may not be applied.
    let watch: Record<string, unknown> | null = null;
    try {
        const [w] = await db.execute(sql`
            SELECT (SELECT count(*)::int FROM lead_watch WHERE paused_reason IS NULL) AS watching,
                   (SELECT count(DISTINCT ai_assistant_id)::int FROM lead_watch WHERE paused_reason IS NULL) AS assistants,
                   (SELECT count(*)::int FROM lead_watch_signals WHERE created_at > now() - interval '7 days') AS signals7d,
                   (SELECT to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM trigger_sources WHERE source = 'lead_watch') AS "lastRunAt",
                   (SELECT last_result FROM trigger_sources WHERE source = 'lead_watch') AS "lastResult",
                   (SELECT to_char(last_ok_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM trigger_sources WHERE source = 'ch_stream_filings') AS "streamOkAt"`) as Array<Record<string, unknown>>;
        watch = { ...w, streamConfigured: !!String(process.env.COMPANIES_HOUSE_STREAM_KEY ?? '').trim() };
    } catch (err) {
        if (!isMissingTable(err)) console.warn('[admin-triggers] watch stats failed', err);
    }

    return {
        setUp: true,
        watch,
        filters: { days, area, trade },
        source: {
            key: FSA_SOURCE,
            enabled: isFsaSourceEnabled(),
            companiesHouseConfigured: isCompaniesHouseConfigured(),
            baselineDoneAt: src?.baseline_done_at ?? null,
            lastRunAt: src?.last_run_at ?? null,
            lastOkAt: src?.last_ok_at ?? null,
            lastResult,
        },
        stock: { listed: n(stock?.listed), current: n(stock?.current) },
        measures: {
            total: n(m?.total), hasAddress: n(m?.has_address), nameCorporate: n(m?.name_corporate),
            checked: n(m?.checked), matched: n(m?.matched), corporate: n(m?.corporate), reachable: n(m?.reachable),
        },
        perDay: perDay.map((r) => ({ day: r.day, count: n(r.count) })),
        byArea: byArea.map((r) => ({ area: r.area, count: n(r.count), reachable: n(r.reachable), corporate: n(r.corporate) })),
        byTrade: byTrade.map((r) => ({ code: r.code, label: r.label, count: n(r.count), reachable: n(r.reachable), corporate: n(r.corporate) })),
        events: events.map((e) => ({
            id: Number(e.id), name: e.name, postcode: e.postcode, area: e.area,
            businessType: e.payload?.businessType ?? null, address: e.payload?.address ?? null,
            hasAddress: !!e.payload?.hasAddress, occurredOn: e.occurred_on,
            label: fhrsLabel({ occurredOn: e.occurred_on, payload: e.payload || {} }).text,
            company: e.company_number ? {
                number: e.company_number, type: e.company_type, matchedBy: e.company_matched_by,
                corporate: isCorporateCompanyType(e.company_type),
                url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(e.company_number)}`,
            } : null,
            companyChecked: !!e.company_checked,
            fsaUrl: `https://ratings.food.gov.uk/business/${encodeURIComponent(String(e.subject_id))}`,
        })),
        areas: areas.map((a) => a.area),
        trades: trades.map((t) => ({ code: t.code, label: t.label || t.code })),
    };
}

// The corporate company types as a Postgres text[] literal, from the one list in trigger-engine.ts.
const CORPORATE_SQL_LIST = `{${CORPORATE_COMPANY_TYPES.join(',')}}`;

export default withLambda(async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'You need the platform_config permission for this page.' });
    const headers = event.headers as Record<string, string | undefined>;
    try {
        if (event.httpMethod === 'GET') return json(200, await overview(event.queryStringParameters || {}));
        if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON.' }); }
        if (body.action === 'run_now') {
            const out = await startTriggerPoll(headers);
            void insertAdminAuditLog({
                adminId: admin.id, action: 'trigger_poll_run', targetType: 'trigger_source', targetId: FSA_SOURCE,
                newState: out, ipAddress: getAdminIp(headers), userAgent: headers['user-agent'],
            });
            return out.started ? json(202, { ok: true }) : json(500, { error: out.error });
        }
        return json(400, { error: 'Unknown action.' });
    } catch (err) {
        if (isMissingTable(err)) return json(200, { setUp: false });
        console.error('[admin-triggers]', err);
        return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
});
