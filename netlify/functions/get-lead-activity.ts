// netlify/functions/get-lead-activity.ts
// GET ?id=<assistantId>&timeframe=1d|7d|30d|90d|all[&limit=<n>]
// → { logs: ActivityItem[], activeJobCount }
//
// The Activity tab for the LEAD roles, in the wire shape get-assistant-activity.ts already
// returns — same { id, type, icon, description, createdAt, status } items, so assistants.js
// renders both feeds with one renderer and this is a routing change on the client, not a second
// activity UI.
//
// ── Why a second endpoint instead of a branch in the first ───────────────────
// get-assistant-activity reads content_generation_jobs, scheduled_posts, post_idea_suggestions and
// media_generation_jobs. A Lead Generator writes to NONE of those — it publishes nothing — so the
// tab it produced for this role was permanently "No activity yet", under a heading promising a
// history, for an assistant that had in fact discovered, scored, emailed and closed leads all week.
// The sources are disjoint, not overlapping, and the same split already exists one card up:
// `metricsSource: 'lead'` routes the KPI grid to get-lead-performance for exactly this reason.
//
// ── Where the facts come from ────────────────────────────────────────────────
// `revenue_events` — the append-only ledger every stage of the lead pipeline already writes
// through recordEvent() (src/utils/revenue-ledger.ts). It carries the timestamp, the actor
// (system / agent / user) and a payload per event, which is precisely an activity feed that nobody
// had yet read back. Nothing new is recorded here; this is a projection.
//
// ⚠️ The ledger is an OBSERVER and its writes are swallowed on failure by design. A missing row
// here means the event was not banked, NOT that the work did not happen — so this feed is
// evidence of activity, never proof of its absence.
//
// Task runs are merged in on top, so an assistant whose discovery ran but found nothing still
// shows the run rather than a blank week.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, revenueEvents, taskRuns } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
// The wording of every feed sentence lives in src/config — pure and unit-tested there
// (tests/lead-activity-projection.test.ts). This file queries; it does not phrase.
import { describeLeadEvent, type ActivityStatus } from '../../src/config/lead-activity-events';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

interface ActivityItem {
    id: string;
    type: string;
    icon: string;
    description: string;
    createdAt: Date;
    status: ActivityStatus;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const aId = Number(event.queryStringParameters?.id);
    if (!Number.isInteger(aId)) return json(400, { error: 'id parameter is required.' });
    const limit = Math.min(Number(event.queryStringParameters?.limit ?? '80') || 80, 200);

    // Same timeframe vocabulary and same default as get-assistant-activity — the tab's chips are
    // shared markup and must mean the same thing whichever feed is behind them.
    const timeframe = event.queryStringParameters?.timeframe ?? '1d';
    const cutoff = (() => {
        const days = timeframe === '1d' ? 1 : timeframe === '7d' ? 7 : timeframe === '90d' ? 90 : timeframe === 'all' ? null : 30;
        if (days === null) return null;
        const d = new Date();
        d.setDate(d.getDate() - days);
        return d;
    })();

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        // IDOR guard.
        const [owned] = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!owned) return json(404, { error: 'Assistant not found.' });

        const [events, runs, activeRuns] = await Promise.all([
            db.select({
                id: revenueEvents.id,
                eventType: revenueEvents.eventType,
                actor: revenueEvents.actor,
                outcome: revenueEvents.outcome,
                lossReason: revenueEvents.lossReason,
                valueGbp: revenueEvents.valueGbp,
                payload: revenueEvents.payload,
                assistantRecordId: revenueEvents.assistantRecordId,
                occurredAt: revenueEvents.occurredAt,
            })
                .from(revenueEvents)
                .where(and(
                    eq(revenueEvents.organisationId, orgId),
                    eq(revenueEvents.aiAssistantId, aId),
                    ...(cutoff ? [gte(revenueEvents.occurredAt, cutoff)] : []),
                ))
                .orderBy(desc(revenueEvents.occurredAt))
                .limit(limit),

            // Task runs — the work the assistant did that the ledger has no event for (a discovery
            // run that surfaced nothing still ran, and "nothing happened this week" and "it looked
            // and found nobody" are different answers to the only question this tab is asked).
            db.select({
                id: taskRuns.id,
                taskType: taskRuns.taskType,
                status: taskRuns.status,
                completedAt: taskRuns.completedAt,
                createdAt: taskRuns.createdAt,
            })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.organisationId, orgId),
                    eq(taskRuns.assistantId, aId),
                    ...(cutoff ? [gte(taskRuns.createdAt, cutoff)] : []),
                ))
                .orderBy(desc(taskRuns.createdAt))
                .limit(limit),

            // Feeds the header's operational status pill, exactly as get-assistant-activity does.
            db.select({ n: sql<number>`count(*)::int` })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.organisationId, orgId),
                    eq(taskRuns.assistantId, aId),
                    inArray(taskRuns.status, ['queued', 'running']),
                )),
        ]);

        // ── Name the leads ───────────────────────────────────────────────────────────────
        // "Scored a lead" twelve times over is a feed that tells you nothing you could act on. The
        // titles come from assistant_records in ONE query keyed on the ids actually present, rather
        // than a join per event — and a lead since deleted simply resolves to no name, which the
        // label functions already fall back through.
        const recordIds = [...new Set(events.map((e) => e.assistantRecordId).filter((n): n is number => Number.isInteger(n as number)))];
        const titles = recordIds.length
            ? await db.select({ id: assistantRecords.id, title: assistantRecords.title })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    inArray(assistantRecords.id, recordIds),
                ))
            : [];
        const titleById = new Map(titles.map((t) => [t.id, t.title]));

        const items: ActivityItem[] = [];

        for (const e of events) {
            const title = e.assistantRecordId != null ? (titleById.get(e.assistantRecordId) ?? null) : null;
            const projected = describeLeadEvent(e, title);
            if (!projected) continue;   // unrenderable event type
            items.push({
                id: `rev-${e.id}`,
                type: e.eventType,
                icon: projected.icon,
                description: projected.description,
                createdAt: e.occurredAt,
                status: projected.status,
            });
        }

        for (const r of runs) {
            const label = String(r.taskType || 'task').replace(/_/g, ' ');
            const status: ActivityStatus = r.status === 'failed' ? 'failed'
                : r.status === 'completed' ? 'success'
                    : 'in_progress';
            const description = r.status === 'failed' ? `A ${label} run failed.`
                : r.status === 'completed' ? `Finished a ${label} run.`
                    : `A ${label} run is in progress.`;
            items.push({
                id: `run-${r.id}`,
                type: 'task_run',
                icon: r.status === 'failed' ? 'alert' : 'settings',
                description,
                createdAt: (r.completedAt ?? r.createdAt) as Date,
                status,
            });
        }

        items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return json(200, {
            logs: items.slice(0, limit),
            activeJobCount: Number(activeRuns[0]?.n ?? 0),
        });
    } catch (err) {
        // revenue_events arrives with db/revenue-events.sql, a MANUAL apply. On an un-migrated
        // environment return an EMPTY feed rather than a 500: the tab then reads "No activity yet",
        // which is exactly what it said before this endpoint existed.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('does not exist') && (msg.includes('relation') || msg.includes('column'))) {
            console.error('[get-lead-activity] schema not migrated — apply db/revenue-events.sql', err);
            return json(200, { logs: [], activeJobCount: 0 });
        }
        console.error('[get-lead-activity]', err);
        return json(500, { error: 'Failed to load activity.' });
    }
});
