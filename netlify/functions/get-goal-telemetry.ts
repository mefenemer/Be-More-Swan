// netlify/functions/get-goal-telemetry.ts
// SMART Goals — Feature 4 / AC4.2.3 Graph-Ready Output. Returns a goal's normalised telemetry
// as Date/Value coordinates plus the required-trajectory line, ready for the Review Progress
// chart (Phase 3). Org-scoped via requireTenant.
//
// GET ?id=<goalId>  →  { goal, actual: [{date,value}], trajectory: [{date,value}] }

import { Handler } from '@netlify/functions';
import { and, eq, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { goals, goalTelemetry } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getGoalMetric } from '../../src/config/goal-metrics';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const goalId = Number(event.queryStringParameters?.id);
    if (!goalId || Number.isNaN(goalId)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!goal || goal.organisationId !== orgId) return { statusCode: 404, body: JSON.stringify({ error: 'Goal not found.' }) };

    const rows = await db
        .select({ value: goalTelemetry.metricValue, recordedAt: goalTelemetry.recordedAt })
        .from(goalTelemetry)
        .where(and(eq(goalTelemetry.goalId, goalId), eq(goalTelemetry.organisationId, orgId)))
        .orderBy(asc(goalTelemetry.recordedAt));

    const actual = rows.map(r => ({ date: r.recordedAt.toISOString(), value: Number(r.value) }));

    // Required trajectory: straight line from the baseline at creation to the target at the deadline.
    const startValue = goal.startValue != null ? Number(goal.startValue) : (actual[0]?.value ?? 0);
    const trajectory = [
        { date: goal.createdAt.toISOString(), value: startValue },
        { date: goal.targetDate.toISOString(), value: Number(goal.targetValue) },
    ];

    const metric = getGoalMetric(goal.metricKey);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            goal: {
                id: goal.id,
                metricKey: goal.metricKey,
                metricLabel: metric?.label ?? goal.metricKey,
                unit: metric?.unit ?? '',
                targetValue: Number(goal.targetValue),
                targetDate: goal.targetDate.toISOString(),
                startValue,
                latestValue: goal.latestValue != null ? Number(goal.latestValue) : null,
                status: goal.status,
            },
            actual,
            trajectory,
        }),
    };
};
