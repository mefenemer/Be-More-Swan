// netlify/functions/refresh-goal.ts
// "Check again now" for SMART Goals — the on-demand counterpart of one iteration of
// poll-goal-telemetry.ts, for ONE goal (or every goal on one assistant).
//
//   POST { goalId }               → re-measure that goal
//   POST { assistantId }          → re-measure every active goal on that assistant
//        → { goals: [{ id, latestValue, status, outcome, lastMeasuredAt }], polled, ... }
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `goals.latest_value` is a CACHE. It only moves when poll-goal-telemetry runs, which is hourly at
// best, once a day on the entry tier, and — on staging, a Netlify branch deploy where scheduled
// functions never fire — only when an external scheduler pokes run-goal-telemetry.ts.
//
// That was survivable while the metrics were right. It stopped being survivable when one wasn't:
// `qualified_leads` counted Be More Swan's OWN `leads` table filtered to a status nothing in the
// Lead Generator ever writes, so the goal read 0/target forever however many leads the assistant
// had qualified. When the query was corrected, every affected goal STAYED at 0 until the next
// sweep, with no way for the person looking at it to make the corrected code run. A user staring
// at a wrong number they cannot refresh has no way to tell a stale cache from a broken feature —
// and reported it, correctly, as the latter.
//
// ── What it deliberately is NOT ──────────────────────────────────────────────
// Not a recompute on page load. These metrics call third-party APIs (Instagram, LinkedIn, YouTube,
// Search Console); measuring on every render would put a fan-out of rate-limited calls behind the
// Overview tab. It is a button, pressed by a person, on a goal they are looking at.
//
// Owner-path (getDb) + explicit org filter, matching poll-goal-telemetry.

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    goals, goalTelemetry, aiAssistants, systemConnections, plans, masterPlans,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { pollCadenceHours } from '../../src/config/goal-metrics';
import { pollOneGoal, type LiConn, type SocialConn } from './poll-goal-telemetry';
import { desc } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

/**
 * Ceiling on a single request's fan-out.
 *
 * A goal poll can be a live third-party call, and this endpoint is reachable by any signed-in user
 * with a button. An assistant with a sane number of goals is well under this; the cap is here so a
 * pathological one cannot turn one click into a minute of API calls inside a function timeout.
 */
const MAX_GOALS_PER_REQUEST = 12;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { goalId?: number; assistantId?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const goalId = Number(body.goalId);
    const assistantId = Number(body.assistantId);
    const byGoal = Number.isInteger(goalId) && goalId > 0;
    const byAssistant = Number.isInteger(assistantId) && assistantId > 0;
    if (!byGoal && !byAssistant) return json(400, { error: 'A goalId or assistantId is required.' });

    try {
        // ⚠️ The org filter is the tenant guard, and it is on the GOALS query rather than on a
        // separate ownership lookup — a goalId from another workspace has to read as "not found",
        // not as "found but refused", and certainly not as a poll of somebody else's goal.
        const rows = await db
            .select()
            .from(goals)
            .where(and(
                eq(goals.organisationId, orgId),
                eq(goals.isActive, true),
                ...(byGoal ? [eq(goals.id, goalId)] : [eq(goals.assistantId, assistantId)]),
            ))
            .limit(MAX_GOALS_PER_REQUEST);

        if (!rows.length) return json(404, { error: 'Goal not found.' });

        // When asked by assistant, confirm the assistant is ours too. The goals query above already
        // guarantees it (goals are org-scoped), but an assistantId that belongs to nobody should
        // 404 rather than silently return an empty success.
        if (byAssistant) {
            const [a] = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);
            if (!a) return json(404, { error: 'Assistant not found.' });
        }

        // The org's tier cadence. Read even though `force` ignores it, so the response can tell the
        // client when the background sweep would next have got here on its own.
        const [tierRow] = await db
            .select({ tierKey: masterPlans.tierKey })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
            .limit(1);
        const cadenceMs = pollCadenceHours(tierRow?.tierKey) * 3600_000;

        // Every active social connection for this org, in one query — the same shape
        // poll-goal-telemetry builds per batch, for the same reason (a metric may need a token).
        const conns = await db
            .select({
                id: systemConnections.id,
                serviceName: systemConnections.serviceName,
                externalUserId: systemConnections.externalUserId,
                vaultRefKey: systemConnections.vaultRefKey,
                metadata: systemConnections.metadata,
            })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.status, 'active'),
                eq(systemConnections.isActive, true),
            ));
        const byService = new Map<string, SocialConn>();
        for (const c of conns) {
            const service = String(c.serviceName).toLowerCase();
            if (!byService.has(service)) byService.set(service, c as SocialConn);   // first wins, as in the sweep
        }

        const now = new Date();
        // Sequential, not Promise.all: this is at most a dozen goals and several of them may hit
        // the same rate-limited third-party API. Fanning them out concurrently is how a refresh
        // button earns a 429 for the workspace.
        const results: Array<{ id: number; outcome: string }> = [];
        for (const goal of rows) {
            let outcome: string;
            try {
                outcome = await pollOneGoal(db, goal, {
                    conns: { byService, li: (byService.get('linkedin') as LiConn | undefined) ?? null },
                    cadenceMs,
                    now,
                    // The whole point of the endpoint — a human is asking, so the tier throttle
                    // that exists to pace a cron does not apply.
                    force: true,
                });
            } catch (e) {
                // One goal's third-party failure must not cost the user the other five.
                console.warn('[refresh-goal] goal', goal.id, 'failed:', e instanceof Error ? e.message : e);
                outcome = 'error';
            }
            results.push({ id: goal.id, outcome });
        }

        // Read the goals back rather than reporting what we think we wrote — pollOneGoal owns the
        // status arithmetic, and the client should render the row that is actually stored.
        const ids = rows.map((g) => g.id);
        const fresh = await db
            .select({
                id: goals.id,
                latestValue: goals.latestValue,
                startValue: goals.startValue,
                targetValue: goals.targetValue,
                status: goals.status,
            })
            .from(goals)
            .where(inArray(goals.id, ids));

        const lastByGoal = new Map<number, string>();
        for (const id of ids) {
            const [t] = await db
                .select({ recordedAt: goalTelemetry.recordedAt })
                .from(goalTelemetry)
                .where(eq(goalTelemetry.goalId, id))
                .orderBy(desc(goalTelemetry.recordedAt))
                .limit(1);
            if (t?.recordedAt) lastByGoal.set(id, t.recordedAt.toISOString());
        }

        const outcomeById = new Map(results.map((r) => [r.id, r.outcome]));
        return json(200, {
            cadenceHours: cadenceMs / 3600_000,
            polled: results.filter((r) => r.outcome === 'polled').length,
            goals: fresh.map((g) => ({
                ...g,
                outcome: outcomeById.get(g.id) ?? 'skipped',
                lastMeasuredAt: lastByGoal.get(g.id) ?? null,
            })),
        });
    } catch (err) {
        // postgres-js wraps the real failure — "Failed query" alone tells you nothing, read `cause`.
        const pg = err as { code?: string; cause?: unknown };
        console.error('[refresh-goal]', { orgId, goalId, assistantId, pgCode: pg?.code, cause: pg?.cause }, err);
        return json(502, { error: 'Could not re-check that goal right now — please try again.' });
    }
});
