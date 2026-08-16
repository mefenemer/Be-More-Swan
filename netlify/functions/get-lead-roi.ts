// netlify/functions/get-lead-roi.ts
// GET ?id=<assistantId>&period=all|month|week
// Feeds the assistant-detail hero's "Effort Saved / Money Saved" strip for the Lead Generation
// Assistant. The arithmetic lives in src/utils/lead-effort.ts; this file is the query, the tenant
// guard, and nothing else.
//
// ── Why this is not get-assistant-metrics ────────────────────────────────────
// That endpoint's formula is posts × content_drafted + task runs × tasks_completed + `leads` ×
// leads_generated. For this role the post term is structurally zero, and the `leads` term reads Be
// More Swan's OWN trial pipeline rather than the tenant's leads (db/schema.ts:3273 calls the name
// collision out) — and only when the assistant happens to be the org's only one. So the strip was
// hidden for this role, and the one assistant sold on "cheaper than hiring someone" never said what
// it had saved. Same split, and the same reason, as get-lead-performance.ts vs
// get-assistant-performance.ts.
//
// ── One query, over the revenue ledger ───────────────────────────────────────
// Every figure comes from `revenue_events`. Nothing is derived from the current shape of
// assistant_records: a lead worked in March and deleted in June still did that work in March.
//
// ⚠️ Two counting rules, and mixing them up is the whole accuracy of the number:
//   • discovery/enrichment count DISTINCT leads — finding the same company twice is one research.
//   • outreach/replies count ROWS — `outreach_sent` is written once per send INCLUDING every
//     sequence follow-up, and each of those really is another email a person would have written.
// EFFORT_ITEMS carries the flag; this query implements both.
//
// ⚠️ Leads are identified by COALESCE(discovered_lead_id, assistant_record_id) — a manually added
// or CSV-imported lead has no discovery row, and keying only on discovered_lead_id would collapse
// every one of them into a single NULL bucket.

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, userProfiles } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { parseRoiPeriod, roiPeriodStart, roiPeriodLabel } from '../../src/utils/roi-period';
import { EFFORT_ITEMS, buildLeadEffort, emptyLeadEffort } from '../../src/utils/lead-effort';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const rawId = event.queryStringParameters?.id;
    if (!rawId || Number.isNaN(parseInt(rawId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const aId = parseInt(rawId);
    const period = parseRoiPeriod(event.queryStringParameters?.period);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const json = (body: unknown) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, periodLabel: roiPeriodLabel(period), ...(body as object) }),
    });

    try {
        // IDOR guard — the assistant instance must belong to the caller's org. The aggregate below
        // is additionally scoped by organisation_id; both are load-bearing.
        const [assistant] = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        const since = roiPeriodStart(period);

        // The per-event counts, one pass. Built from EFFORT_ITEMS rather than written out, so
        // adding a kind of work is a one-line change in the config and not a second place to edit
        // that can silently disagree with the first.
        //
        // ⚠️ `sql.raw` is used ONLY for the event-type literal and the alias, both of which come
        // from the frozen EFFORT_ITEMS array in this repo — never from request input.
        const selects = EFFORT_ITEMS.map((it) => {
            const inner = it.distinct ? sql`DISTINCT lead_key` : sql`*`;
            return sql`count(${inner}) FILTER (WHERE event_type = ${it.eventType})::int AS ${sql.raw(`"${it.eventType}"`)}`;
        });

        const [row] = await db.execute<Record<string, number>>(sql`
            WITH ev AS (
                SELECT
                    event_type,
                    COALESCE(discovered_lead_id::text, 'r' || assistant_record_id::text) AS lead_key
                  FROM revenue_events
                 WHERE organisation_id = ${orgId}
                   AND ai_assistant_id = ${aId}
                   AND occurred_at >= ${since.toISOString()}::timestamptz
            )
            SELECT ${sql.join(selects, sql`, `)} FROM ev
        `);

        // The user's own rate, from the same preferences blob get-assistant-metrics reads, so the
        // two strips can never quote different money for the same hours.
        const [profile] = await db
            .select({ preferences: userProfiles.preferences })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        const prefs = (profile?.preferences as Record<string, unknown>) || {};
        const rate = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        const mult = await getTimeMultipliers();
        const counts: Record<string, number> = {};
        for (const it of EFFORT_ITEMS) counts[it.eventType] = Number(row?.[it.eventType]) || 0;

        return json(buildLeadEffort(counts, mult, Number.isFinite(rate as number) ? rate : null));
    } catch (err) {
        // ⚠️ READ err.cause, NOT err.message. drizzle rethrows every query failure as
        // "Failed query: WITH ev AS (…)" and puts the real Postgres error (and its SQLSTATE) on
        // `cause`. get-lead-performance.ts shipped reading `message` alone and its migration branch
        // could therefore never match; don't repeat it.
        const cause = (err as { cause?: unknown })?.cause;
        const msg = [
            err instanceof Error ? err.message : '',
            cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '',
        ].join(' ');
        const code = (cause as { code?: string })?.code;

        // revenue_events is a MANUAL apply (db/revenue-events.sql). An honest empty beats a 500 on
        // an environment that simply has no ledger table yet.
        //
        // ⚠️ 42P01 (undefined_TABLE) only — never 42703 (undefined_COLUMN), which is almost always a
        // bug in the query above and must stay loud.
        if (code === '42P01' || (msg.includes('does not exist') && msg.includes('relation'))) {
            console.error('[get-lead-roi] revenue_events not present, returning empty:', msg);
            return json(emptyLeadEffort());
        }
        console.error('[get-lead-roi]', msg, err);
        // This strip is supplementary chrome on the hero — degrade rather than break the page.
        return json(emptyLeadEffort());
    }
});
