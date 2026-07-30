// netlify/functions/record-goal-value.ts
// SMART Goals — user-reported metrics. The write path for a `source: 'manual'` goal.
//
// POST { goalId, value }  → appends a dated goal_telemetry row (source='manual'), refreshes the
//                           goal's latest/start value and status, and recompiles the blueprint if
//                           the status genuinely changed.
//
// This is the manual counterpart of one iteration of poll-goal-telemetry, and it deliberately mirrors
// that function's write block rather than inventing a second convention: same baseline capture, same
// computeGoalProgress call, same recompile-on-transition rule.
//
// Why a separate endpoint rather than a PATCH on manage-goals: this writes TELEMETRY, not the goal.
// manage-goals' PATCH re-runs the attainability check on every write and recompiles unconditionally;
// a monthly figure must do neither. (It also must never touch targetValue — a user entering
// "£240,000 of revenue so far" is reporting progress, not moving the goalposts.)
//
// Owner-path (getDb) + explicit org filter, like manage-goals and the poller.

import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { goals, goalTelemetry } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    getGoalMetric,
    isManualMetric,
    staleWindowHoursFor,
    staleStatusFor,
    nextUpdateDue,
} from '../../src/config/goal-metrics';
import { computeGoalProgress } from '../../src/utils/goal-progress';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

// A figure large enough to cover any business we will plausibly serve, small enough that a fat-finger
// paste (a phone number, a date typed as digits) is caught rather than stored as a target-smashing
// value that permanently marks the goal complete.
const MAX_VALUE = 1e12;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;
    if (!orgId) return json(400, { error: 'No organisation.' });

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const goalId = Number(body.goalId);
    const value = Number(body.value);
    if (!goalId || Number.isNaN(goalId)) return json(400, { error: 'goalId is required.' });
    // Zero is a legitimate report ("no bookings this week"), so the floor is 0, not 1. Negative is
    // not — every manual metric in the catalog is a count or an amount.
    if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) {
        return json(400, { error: 'Enter a number of 0 or more.' });
    }

    const [goal] = await db
        .select()
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.organisationId, orgId)))
        .limit(1);
    if (!goal) return json(404, { error: 'Goal not found.' });

    // Only manual metrics accept a typed value. Letting one through for a polled metric would put a
    // hand-entered number into a series the next poll silently overwrites — the user would see their
    // figure accepted, then vanish an hour later with no explanation.
    if (!isManualMetric(goal.metricKey)) {
        const label = getGoalMetric(goal.metricKey)?.label ?? goal.metricKey;
        return json(400, {
            error: `"${label}" is tracked automatically — it can't be updated by hand.`,
            code: 'METRIC_NOT_MANUAL',
        });
    }
    if (!goal.isActive) return json(409, { error: 'This goal is archived.' });

    const now = new Date();
    await db.insert(goalTelemetry).values({
        goalId: goal.id,
        organisationId: orgId,
        metricValue: String(value),
        source: 'manual',
        enteredByUserId: userId ?? null,
        recordedAt: now,
    });

    // The first entry sets the baseline, exactly as the first poll does. Without it `needed` would be
    // measured from zero and a business reporting £240k against a £250k target would read as 96%
    // complete on day one.
    const startValue = goal.startValue == null ? value : Number(goal.startValue);

    const [{ n: dataPoints }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(goalTelemetry)
        .where(eq(goalTelemetry.goalId, goal.id));

    const progress = computeGoalProgress({
        startValue,
        latestValue: value,
        targetValue: Number(goal.targetValue),
        createdAt: goal.createdAt,
        targetDate: goal.targetDate,
        direction: getGoalMetric(goal.metricKey)?.direction ?? 'increase',
        lastTelemetryAt: now,
        staleAfterHours: staleWindowHoursFor(goal.metricKey),
        staleStatus: staleStatusFor(goal.metricKey),
        // Judge the trend as of this entry, and only once there are two of them — see the
        // rateAsOfLastEntry / minDataPoints notes in goal-progress.ts.
        rateAsOfLastEntry: true,
        dataPoints: Number(dataPoints ?? 1),
        minDataPoints: 2,
        now,
    });

    await db.update(goals).set({
        latestValue: String(value),
        startValue: String(startValue),
        status: progress.status,
        statusUpdatedAt: now,
        updatedAt: now,
    }).where(eq(goals.id, goal.id));

    // Same rule as the poller: generation reads the PERSISTED blueprint, so a status transition has
    // to be recompiled in to reach the next draft — and only a transition, or a monthly entry would
    // churn a blueprint row for nothing. Best-effort; the entry is already committed.
    if (progress.status !== goal.status) {
        try {
            await assembleBlueprint(goal.assistantId, `user-${userId}`, `goal_status_${progress.status}`);
        } catch (e) {
            console.warn(`[record-goal-value] recompile after ${goal.status}→${progress.status} failed (value still saved):`,
                e instanceof Error ? e.message : e);
        }
    }

    // The entry BEFORE the one just written, so the client can show "up from £180,000 on 1 Jul".
    // Taken as the second row of a plain desc ordering rather than with a `recordedAt < now` filter:
    // a JS Date interpolated into a raw sql`` template dies in the postgres-js Bind step, and the
    // error it raises ("Failed query") names the wrong cause. Two rows and an index avoid it entirely.
    const [, previous] = await db
        .select({ recordedAt: goalTelemetry.recordedAt, metricValue: goalTelemetry.metricValue })
        .from(goalTelemetry)
        .where(and(eq(goalTelemetry.goalId, goal.id), eq(goalTelemetry.source, 'manual')))
        .orderBy(desc(goalTelemetry.recordedAt))
        .limit(2);

    return json(200, {
        ok: true,
        goalId: goal.id,
        value,
        status: progress.status,
        pct: progress.pct,
        recordedAt: now.toISOString(),
        nextDueAt: nextUpdateDue(goal.metricKey, now)?.toISOString() ?? null,
        previous: previous
            ? { value: Number(previous.metricValue), recordedAt: (previous.recordedAt as Date).toISOString() }
            : null,
    });
});
