// netlify/functions/get-lead-performance.ts
// GET ?id=<assistantId>
// Feeds the four assistant-detail "Performance Metrics" KPI cards for the Lead Generation
// Assistant. The arithmetic lives in src/utils/lead-performance.ts; this file is the query, the
// tenant guard, and nothing else.
//
// Deliberately SEPARATE from get-assistant-performance.ts, for the same reason
// get-campaign-performance.ts is. That endpoint answers "how did this assistant's own POSTS
// perform" off `post_insights` — a question this assistant cannot have, because it publishes
// nothing. It returned hasData:false for ever, and the card grid told every Lead Generator user
// that "nothing has been published in the last 30 days", which is true, permanent, and about a
// different product.
//
// ── One query, over the revenue ledger ──────────────────────────────────────────────────────────
// Every figure comes from `revenue_events`, which is the append-only fact stream every lead
// lifecycle transition already writes to (src/utils/revenue-ledger.ts is its only writer). Nothing
// here derives state from the current shape of `assistant_records`, and that is on purpose: a
// lead's row tells you where it is NOW, while these cards are about what HAPPENED in a window. A
// lead approved in March and deleted in June must still count as approved in March.
//
// ⚠️ COUNT(DISTINCT lead) on the engagement rows, not COUNT(*). `outreach_sent` is written once per
// send INCLUDING every sequence follow-up (see the comment on it in src/config/revenue-events.ts),
// so counting rows would inflate the denominator every time a chase went out and drop the reply
// rate for doing more work.
//
// ⚠️ Leads are identified by COALESCE(discovered_lead_id, assistant_record_id) — a manually added
// or CSV-imported lead has no discovery row, and keying only on discovered_lead_id would silently
// collapse all of them into one NULL bucket.

import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    LEAD_PERFORMANCE_DAYS, buildLeadPerformance, emptyLeadPerformance,
    type LeadPerformanceCounts,
} from '../../src/utils/lead-performance';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const rawId = event.queryStringParameters?.id;
    if (!rawId || Number.isNaN(parseInt(rawId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
    const aId = parseInt(rawId);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const json = (body: unknown) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    try {
        // IDOR guard — same shape as get-campaign-performance.ts. The org filter on the aggregate
        // below is the other half; both are load-bearing.
        const [assistant] = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        // One pass over the window. Written as raw SQL because every figure is the same shape —
        // a FILTERed count over one table — and expressing eleven of them as Drizzle selects would
        // be eleven round trips for one answer.
        //
        // `lead_rejected` covers deletions too: assistant-records.ts's DELETE marks a lead rejected
        // and writes this same event, so a user who clears their queue with Delete is measured
        // exactly like one who used the old Reject button.
        const [row] = await db.execute<{
            discovered: number; approved: number; rejected: number;
            contacted: number; replied: number; opted_out: number;
            won: number; lost: number; disqualified: number;
            won_value: string | null;
        }>(sql`
            WITH ev AS (
                SELECT
                    event_type,
                    outcome,
                    value_gbp,
                    COALESCE(discovered_lead_id::text, 'r' || assistant_record_id::text) AS lead_key
                  FROM revenue_events
                 WHERE organisation_id = ${orgId}
                   AND ai_assistant_id = ${aId}
                   AND occurred_at >= now() - (${LEAD_PERFORMANCE_DAYS}::int * INTERVAL '1 day')
            )
            SELECT
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'lead_discovered')::int    AS discovered,
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'lead_approved')::int      AS approved,
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'lead_rejected')::int      AS rejected,
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'outreach_sent')::int      AS contacted,
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'reply_received')::int     AS replied,
                count(DISTINCT lead_key) FILTER (WHERE event_type = 'opt_out_received')::int   AS opted_out,
                count(*) FILTER (WHERE outcome = 'won')::int                                   AS won,
                count(*) FILTER (WHERE outcome = 'lost')::int                                  AS lost,
                count(*) FILTER (WHERE outcome = 'disqualified')::int                          AS disqualified,
                sum(value_gbp) FILTER (WHERE outcome = 'won')                                  AS won_value
              FROM ev
        `);

        // No ledger rows at all in the window. The aggregate returns a row of zeroes rather than
        // no row, but guard both — a missing row must not become NaN on a card.
        if (!row) return json(emptyLeadPerformance());

        const counts: LeadPerformanceCounts = {
            discovered: Number(row.discovered) || 0,
            approved: Number(row.approved) || 0,
            rejected: Number(row.rejected) || 0,
            contacted: Number(row.contacted) || 0,
            replied: Number(row.replied) || 0,
            optedOut: Number(row.opted_out) || 0,
            won: Number(row.won) || 0,
            lost: Number(row.lost) || 0,
            disqualified: Number(row.disqualified) || 0,
            // ⚠️ numeric comes back as a STRING. Number('') is 0, so an empty sum would silently
            // report "£0 won" beside a real win — null it explicitly instead.
            wonValueGbp: row.won_value === null || row.won_value === undefined || row.won_value === ''
                ? null
                : Number(row.won_value),
        };

        return json(buildLeadPerformance(counts));
    } catch (err) {
        // ⚠️ READ err.cause, NOT err.message. drizzle rethrows every query failure as
        // "Failed query: WITH ev AS (…)" — the real Postgres error (and its SQLSTATE) is on
        // `cause`. This function shipped reading `message` alone, which meant the
        // not-migrated branch below could never match and EVERY failure became a 500 that the
        // card grid renders as "Performance metrics couldn't be loaded". Same trap as
        // raw-sql-date-param-trap, which cost three wrong diagnoses.
        const cause = (err as { cause?: unknown })?.cause;
        const msg = [
            err instanceof Error ? err.message : '',
            cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '',
        ].join(' ');

        // Not migrated yet (revenue_events is a manual apply — db/revenue-events.sql). An honest
        // empty beats a 500 that renders as "couldn't be loaded" on an account that simply has no
        // ledger table yet.
        //
        // ⚠️ 42P01 (undefined_TABLE) ONLY — deliberately NOT 42703 (undefined_COLUMN), which the
        // first draft of this fix also swallowed. A missing table is an environment state this
        // repo really produces, because db/*.sql is applied by hand. A missing COLUMN is almost
        // always a bug in the query above, and swallowing it would have turned the exact defect
        // that caused this incident (a CTE with no FROM → 42703) into a silent "No lead activity
        // to measure yet" — a wrong answer, quietly, instead of a loud one. A query bug must stay
        // visible; only the migration gap gets to degrade gracefully.
        const code = (cause as { code?: string })?.code;
        if (code === '42P01' || (msg.includes('does not exist') && msg.includes('relation'))) {
            console.error('[get-lead-performance] revenue_events not present, returning empty:', msg);
            return json(emptyLeadPerformance());
        }
        // Log the CAUSE explicitly — logging `err` alone prints the useless wrapper.
        console.error('[get-lead-performance]', msg, err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load performance.' }) };
    }
});
