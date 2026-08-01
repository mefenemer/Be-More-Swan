// netlify/functions/manage-goals.ts
// Epic: AI-Driven SMART Goals — Feature 1 (US1.1 Measurable Goal Creation).
// Per-assistant goal CRUD. Owner-path + manual org filter (no RLS) — same pattern as
// content-rules.ts / post_insights. Org is resolved via requireTenant (the JWT carries
// activeOrganisationId, NOT organisationId — see [[social-oauth-and-disclosure]]).
//
// GET    ?assistantId=N  → { goals: [...], availableMetrics: [...] }  (catalog gated by active connections — AC1.1.3)
// POST   { assistantId, metricKey, targetValue, targetDate, title?, rationale?, isPrimary? }  → create (AC1.1.2)
// PATCH  { id, targetValue?, targetDate?, title?, rationale?, isPrimary?, isActive? }  → update
// DELETE ?id=N  → delete
//
// Every write recompiles the assistant's blueprint. This is what makes a goal steer generation:
// blueprint section 12 carries the active goals and the funnel directive the drafting prompt reads
// (src/utils/goal-directive.ts). Without the recompile a user could change a target and the next
// post would still be generated against the previous one — which was effectively the old behaviour,
// since nothing read goals at all.

import { Handler } from '@netlify/functions';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { goals, goalTelemetry, aiAssistants, masterAssistants, systemConnections, workspaceIntegrations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { normalizeMediaSources } from '../../src/utils/media-sources';
import { monthlyAllowance } from '../../src/utils/ai-credits';
import {
    assessGoalRealism,
    availableMetricsForRole,
    getGoalMetric,
    isValidMetricKey,
    isManualMetric,
    nextUpdateDue,
    pollCadenceHours,
    tierAllows,
} from '../../src/config/goal-metrics';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { summariseGoals, pickHeadlineGoal } from '../../src/utils/goal-summary';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

/** Max lengths for the free-text SMART fields — long enough to be useful, short enough not to
 *  crowd out the rest of the brief (the rationale is injected verbatim into the drafting prompt). */
const TITLE_MAX = 120;
const RATIONALE_MAX = 600;

/**
 * Normalise an optional free-text field: trim, collapse to null when blank, enforce a cap.
 * Returns `undefined` when the caller didn't supply the field at all (so PATCH can tell
 * "not provided" from "explicitly cleared").
 */
function optionalText(v: unknown, max: number): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    return s.slice(0, max);
}

/**
 * The best-known current value of a metric for this assistant, for the attainability check.
 *
 * WHY THIS MATTERS: `assessGoalRealism` treats a missing baseline as 0, which makes it measure the
 * wrong distance — it checks "can you reach the whole target from nothing", not "can you close the
 * remaining gap". That is usually harmlessly lenient, but it misfires badly at the top end: an
 * account on 19,000 followers asking for 20,000 by tomorrow needs +1,000, yet with no baseline the
 * check computes 20,000/day, blocks the goal, and tells the user their target "needs about 20,000
 * followers per day" — a figure that is simply wrong.
 *
 * A goal on this metric that has already been polled carries the value on `latestValue`, so reuse it.
 * Returns null when nothing is known (a genuinely first goal), which is the documented conservative
 * case. Scoped by organisation AND assistant.
 */
async function knownBaseline(db: any, assistantId: number, orgId: number, metricKey: string): Promise<number | null> {
    const [row] = await db.select({ latestValue: goals.latestValue })
        .from(goals)
        .where(and(
            eq(goals.assistantId, assistantId),
            eq(goals.organisationId, orgId),
            eq(goals.metricKey, metricKey),
            sql`${goals.latestValue} IS NOT NULL`,
        ))
        .orderBy(desc(goals.updatedAt))
        .limit(1);
    const v = row?.latestValue;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * Recompile the blueprint so a goal change reaches the next generated post (section 12).
 *
 * Best-effort by design — same rationale as content-rules.ts: this is data assembly with no LLM
 * call, and the user's write is already committed by the time it runs, so a recompile failure must
 * never surface as a failed save.
 */
async function recompileAfterGoalChange(assistantId: number | null, userId: number, what: string) {
    if (!assistantId) return;
    try {
        await assembleBlueprint(assistantId, `user-${userId}`, 'goal_change');
    } catch (e) {
        console.warn(`[manage-goals] blueprint recompile after ${what} failed (change still saved):`,
            e instanceof Error ? e.message : e);
    }
}

/**
 * A user-reported metric can never be an assistant's PRIMARY goal — returns an error payload when
 * the caller tries, or null when the combination is fine.
 *
 * The primary goal is the one the assistant is measured on: it drives the progress bar in the detail
 * header, it is what the drafting prompt is steered toward, and it is what the autonomous optimizer
 * reacts to. None of those are honest for a number the assistant cannot move. Revenue is a real goal
 * and worth tracking beside the work — it is just not this assistant's scoreboard, and promoting it
 * to primary would quietly reframe "the content is underperforming" as "sales are down".
 */
function manualPrimaryError(metricKey: string): { error: string; code: string } | null {
    if (!isManualMetric(metricKey)) return null;
    const label = getGoalMetric(metricKey)?.label ?? metricKey;
    return {
        error: `"${label}" is a figure you report yourself, so it can't be this assistant's primary goal — `
            + `its work isn't what moves that number. Keep it as a supporting goal and make something `
            + `this assistant measurably drives the primary one.`,
        code: 'MANUAL_METRIC_NOT_PRIMARY',
    };
}

/** Active third-party services connected for this org (lowercased serviceName). */
async function connectedServices(db: any, orgId: number): Promise<string[]> {
    const rows = await db
        .selectDistinct({ serviceName: systemConnections.serviceName })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ));

    // Connections live in TWO tables. Social accounts (instagram, linkedin, x…) are rows in
    // system_connections; everything OAuthed through the integrations directory — Search Console,
    // HubSpot, Xero, Gmail… — is a workspace_integrations row keyed by `provider`. Gating only on
    // system_connections meant a metric backed by an integration could never become available no
    // matter what the user connected, which is why `search_clicks` needs this union.
    const integrations = await db
        .selectDistinct({ provider: workspaceIntegrations.provider })
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.organisationId, orgId),
            eq(workspaceIntegrations.status, 'active'),
        ));

    return [
        ...rows.map((r: any) => String(r.serviceName).toLowerCase()),
        ...integrations.map((r: any) => String(r.provider).toLowerCase()),
    ];
}

/** Verify the assistant exists and belongs to the caller's org. */
async function assertOwnedAssistant(db: any, assistantId: number, orgId: number): Promise<boolean> {
    const [row] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    return !!row;
}

/** The master-catalog roleKey for an assistant (null for legacy assistants with no master row). */
async function assistantRoleKey(db: any, assistantId: number, orgId: number): Promise<string | null> {
    const [row] = await db
        .select({ roleKey: masterAssistants.roleKey })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    return (row?.roleKey as string | null) ?? null;
}

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    // ── GET — goals for an assistant + the metric catalog gated by connections ──
    if (method === 'GET') {
        const assistantId = Number(params.assistantId);
        if (!assistantId || Number.isNaN(assistantId)) {
            return json(400, { error: 'assistantId is required.' });
        }
        const [assistant] = await db
            .select({
                id: aiAssistants.id,
                autonomousGoalSeeking: aiAssistants.autonomousGoalSeeking,
                autonomousMediaEnabled: aiAssistants.autonomousMediaEnabled,
                autonomousMediaMonthlyCap: aiAssistants.autonomousMediaMonthlyCap,
                mediaSources: aiAssistants.mediaSources,
            })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found.' });

        const rows = await db
            .select()
            .from(goals)
            .where(and(eq(goals.assistantId, assistantId), eq(goals.organisationId, orgId), eq(goals.isActive, true)))
            .orderBy(desc(goals.isPrimary), desc(goals.createdAt));

        const services = await connectedServices(db, orgId);
        const roleKey = await assistantRoleKey(db, assistantId, orgId);
        const tierKey = await getActiveTierKeyByOrg(db, orgId);
        const planMonthlyCredits = await monthlyAllowance(db, orgId);

        // When each user-reported goal was last given a figure. The Goals tab needs it for the "you
        // last updated this on …" line and to know which cards are overdue; without it a manual goal
        // renders identically to a polled one and the user has no idea it is waiting on them.
        // One query for the whole assistant — a per-card fetch would be N round-trips on every render.
        const manualGoalIds = rows.filter((g: any) => isManualMetric(g.metricKey)).map((g: any) => g.id as number);
        const lastEntryByGoal = new Map<number, Date>();
        if (manualGoalIds.length) {
            const entries = await db
                .select({ goalId: goalTelemetry.goalId, recordedAt: goalTelemetry.recordedAt })
                .from(goalTelemetry)
                .where(and(inArray(goalTelemetry.goalId, manualGoalIds), eq(goalTelemetry.source, 'manual')))
                .orderBy(desc(goalTelemetry.recordedAt));
            for (const e of entries) {
                if (!lastEntryByGoal.has(e.goalId as number)) lastEntryByGoal.set(e.goalId as number, e.recordedAt as Date);
            }
        }

        // When each goal was last MEASURED, whatever the source. Distinct from lastEnteredAt above:
        // that one is manual-only and answers "when did you last type a figure in", this one answers
        // "how fresh is the number on the bar" for polled goals too. The Goal Progress card states
        // the tracking cadence and the next check, and it can only do that honestly if it knows when
        // the last one actually landed — see _renderGoalFreshnessNote in assistants.js.
        const lastMeasuredByGoal = new Map<number, Date>();
        if (rows.length) {
            const measured = await db
                .select({ goalId: goalTelemetry.goalId, at: sql<string>`max(${goalTelemetry.recordedAt})` })
                .from(goalTelemetry)
                .where(inArray(goalTelemetry.goalId, rows.map((g: any) => g.id as number)))
                .groupBy(goalTelemetry.goalId);
            for (const m of measured) {
                if (m.at) lastMeasuredByGoal.set(m.goalId as number, new Date(m.at as unknown as string));
            }
        }

        // Which goal the assistant-detail HEADER should show. Computed here, with the same rule the
        // dashboard card uses (src/utils/goal-summary.ts), so the two surfaces can never disagree
        // about which goal represents this assistant. The client used to pick it itself with
        // `find(isPrimary) || goals[0]` — and since a user-reported metric can never be primary, an
        // assistant with only revenue goals got whichever was newest.
        const headlineGoalId = pickHeadlineGoal(rows as any[])?.id ?? null;

        return json(200, {
            // Each goal carries its metric's objective, label and unit so the client never has to
            // look them up in `availableMetrics`. A goal can outlive its metric's availability — the
            // connection was removed, or we marked the metric unmeasurable (linkedin_followers) — and
            // the edit form still has to show what the goal tracks rather than rendering blank.
            goals: rows.map((g: any) => {
                const m = getGoalMetric(g.metricKey);
                const lastEnteredAt = lastEntryByGoal.get(g.id) ?? null;
                return {
                    ...g,
                    objective: m?.objective ?? null,
                    metricLabel: m?.label ?? g.metricKey,
                    unit: m?.unit ?? '',
                    // User-reported goals render a different card: an entry box and a due date rather
                    // than a "syncing" line. Everything the card needs travels with the goal.
                    isManual: m?.source === 'manual',
                    updateCadenceDays: m?.updateCadenceDays ?? null,
                    lastEnteredAt: lastEnteredAt ? lastEnteredAt.toISOString() : null,
                    nextDueAt: nextUpdateDue(g.metricKey, lastEnteredAt)?.toISOString() ?? null,
                    // Last measurement of ANY source — what the Goal Progress card's freshness line
                    // is computed from. null means this goal has never been measured.
                    lastMeasuredAt: lastMeasuredByGoal.get(g.id)?.toISOString() ?? null,
                };
            }),
            availableMetrics: availableMetricsForRole(roleKey, services),
            headlineGoalId,
            // How often poll-goal-telemetry is allowed to re-check this org's goals (AC4.1.1 — hourly
            // on paid tiers, daily on entry). The client states the cadence to the user, and must read
            // it from here: a hardcoded "hourly" in the UI becomes a lie the moment a tier changes.
            pollCadenceHours: pollCadenceHours(tierKey),
            goalSummary: summariseGoals(rows as any[]),
            autonomousGoalSeeking: assistant.autonomousGoalSeeking,
            autonomousMediaEnabled: assistant.autonomousMediaEnabled,
            autonomousMediaMonthlyCap: assistant.autonomousMediaMonthlyCap,
            planMonthlyCredits,
            mediaSources: normalizeMediaSources(assistant.mediaSources),
            // Feature 3 premium gates (AC3.1.1) — the client shows padlocks / upgrade prompts off these.
            entitlements: {
                aiRecommendations: tierAllows('recommendations', tierKey),
                magicWand: tierAllows('magicWand', tierKey),
                autonomous: tierAllows('autonomous', tierKey),
            },
        });
    }

    // ── POST — create a goal ─────────────────────────────────────────────────
    if (method === 'POST') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const { assistantId, metricKey, targetValue, targetDate, isPrimary } = body;
        if (!assistantId || !metricKey || targetValue == null || !targetDate) {
            return json(400, { error: 'assistantId, metricKey, targetValue and targetDate are required.' });
        }
        if (!isValidMetricKey(metricKey)) {
            return json(400, { error: 'Unknown target metric.' });
        }
        // Reject a metric we cannot actually measure, even if a stale client still offers it.
        // `linkedin_followers` is the live example: it needs LinkedIn organisation scopes we are not
        // approved for, so a goal set on it would sit 'pending' and then rot to 'data_disconnected'
        // forever. Failing here is far kinder than accepting a goal that can never move.
        if (!getGoalMetric(metricKey)!.available) {
            return json(400, {
                error: `"${getGoalMetric(metricKey)!.label}" can't be measured yet, so a goal can't be set against it.`,
                code: 'METRIC_UNAVAILABLE',
            });
        }

        const title = optionalText(body.title, TITLE_MAX) ?? null;
        const rationale = optionalText(body.rationale, RATIONALE_MAX) ?? null;
        const target = Number(targetValue);
        if (!Number.isFinite(target) || target <= 0) {
            return json(400, { error: 'targetValue must be a positive number.' });
        }
        const when = new Date(targetDate);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
            return json(400, { error: 'targetDate must be a valid future date.' });
        }

        if (!(await assertOwnedAssistant(db, Number(assistantId), orgId))) {
            return json(404, { error: 'Assistant not found.' });
        }

        // Attainability guard — reject clearly-impossible targets (e.g. +10M followers in a day).
        // Runs AFTER the ownership check so the baseline lookup below can only ever read this org's
        // own rows.
        const realism = assessGoalRealism({
            metricKey, targetValue: target, targetDate: when,
            baseline: await knownBaseline(db, Number(assistantId), orgId, metricKey),
        });
        if (!realism.ok) {
            return json(422, {
                error: [realism.reason, realism.suggestion].filter(Boolean).join(' '),
                code: 'GOAL_UNREALISTIC',
                attainableTarget: realism.attainableTarget,
            });
        }

        // The metric must belong to this assistant's role — stops a client from setting an
        // "Instagram Followers" goal on an Accounts Receivable Clerk (and vice-versa).
        const roleKey = await assistantRoleKey(db, Number(assistantId), orgId);
        const services = await connectedServices(db, orgId);
        const metric = getGoalMetric(metricKey)!;
        if (!availableMetricsForRole(roleKey, services).some(m => m.key === metricKey)) {
            // Connection-backed metric that simply isn't connected yet → the more specific 409 below.
            if (!(metric.source === 'connection' && metric.connectionService && !services.includes(metric.connectionService))) {
                return json(400, { error: `"${metric.label}" is not available for this assistant.` });
            }
        }

        // AC1.1.3 — connection-backed metrics require the relevant service to be connected.
        if (metric.source === 'connection' && metric.connectionService) {
            if (!services.includes(metric.connectionService)) {
                return json(409, {
                    error: `Connect ${metric.connectionService} before setting a "${metric.label}" goal.`,
                    code: 'METRIC_NOT_CONNECTED',
                });
            }
        }

        const primaryErr = isPrimary ? manualPrimaryError(metricKey) : null;
        if (primaryErr) return json(400, primaryErr);

        // Only one primary goal per assistant — demote the others first.
        if (isPrimary) {
            await db.update(goals)
                .set({ isPrimary: false, updatedAt: new Date() })
                .where(and(eq(goals.assistantId, Number(assistantId)), eq(goals.organisationId, orgId)));
        }

        const [created] = await db.insert(goals).values({
            organisationId: orgId,
            assistantId: Number(assistantId),
            metricKey,
            title,
            rationale,
            targetValue: String(target),
            targetDate: when,
            isPrimary: Boolean(isPrimary),
            status: 'pending',          // run-rate engine (Phase 2) assigns the rest once telemetry arrives
            createdByUserId: userId,
        }).returning();

        await recompileAfterGoalChange(Number(assistantId), userId, 'create');
        return json(201, { goal: created });
    }

    // ── PATCH — update a goal, or toggle autonomous mode (US3.3) ──────────────
    if (method === 'PATCH') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        // Assistant-level: Autonomous Goal Seeking toggle (premium-gated, AC3.3.1).
        if (body.assistantId != null && typeof body.autonomousGoalSeeking === 'boolean') {
            if (!(await assertOwnedAssistant(db, Number(body.assistantId), orgId))) {
                return json(404, { error: 'Assistant not found.' });
            }
            if (body.autonomousGoalSeeking) {
                const tierKey = await getActiveTierKeyByOrg(db, orgId);
                if (!tierAllows('autonomous', tierKey)) {
                    return json(402, { error: 'Autonomous optimization requires a higher plan.', code: 'UPGRADE_REQUIRED' });
                }
            }
            await db.update(aiAssistants)
                .set({ autonomousGoalSeeking: body.autonomousGoalSeeking })
                .where(and(eq(aiAssistants.id, Number(body.assistantId)), eq(aiAssistants.organisationId, orgId)));
            return json(200, { autonomousGoalSeeking: body.autonomousGoalSeeking });
        }

        const { id, targetValue, targetDate, isPrimary, isActive } = body;
        if (!id) return json(400, { error: 'id is required.' });

        const [existing] = await db.select().from(goals).where(eq(goals.id, Number(id))).limit(1);
        if (!existing || existing.organisationId !== orgId) return json(404, { error: 'Goal not found.' });

        const updates: Record<string, any> = { updatedAt: new Date() };
        if (targetValue !== undefined) {
            const t = Number(targetValue);
            if (!Number.isFinite(t) || t <= 0) return json(400, { error: 'targetValue must be a positive number.' });
            updates.targetValue = String(t);
        }
        if (targetDate !== undefined) {
            const when = new Date(targetDate);
            if (Number.isNaN(when.getTime())) return json(400, { error: 'targetDate is invalid.' });
            updates.targetDate = when;
        }
        if (isActive !== undefined) updates.isActive = Boolean(isActive);

        // SMART "Specific". `null` explicitly clears the field; omitting the key leaves it untouched.
        const nextTitle = optionalText(body.title, TITLE_MAX);
        if (nextTitle !== undefined) updates.title = nextTitle;
        const nextRationale = optionalText(body.rationale, RATIONALE_MAX);
        if (nextRationale !== undefined) updates.rationale = nextRationale;

        // Re-check attainability whenever the target value or date changes.
        if (targetValue !== undefined || targetDate !== undefined) {
            const effectiveTarget = updates.targetValue !== undefined ? Number(updates.targetValue) : Number(existing.targetValue);
            const effectiveDate = updates.targetDate !== undefined ? updates.targetDate : existing.targetDate;
            // Baseline is right here on the row — pass it, or the check measures the wrong distance.
            const baseline = existing.latestValue ?? existing.startValue;
            const realism = assessGoalRealism({
                metricKey: existing.metricKey,
                targetValue: effectiveTarget,
                targetDate: effectiveDate,
                baseline: baseline != null ? Number(baseline) : null,
            });
            if (!realism.ok) {
                return json(422, {
                    error: [realism.reason, realism.suggestion].filter(Boolean).join(' '),
                    code: 'GOAL_UNREALISTIC',
                    attainableTarget: realism.attainableTarget,
                });
            }
        }

        if (isPrimary === true) {
            const primaryErr = manualPrimaryError(existing.metricKey);
            if (primaryErr) return json(400, primaryErr);
            await db.update(goals)
                .set({ isPrimary: false, updatedAt: new Date() })
                .where(and(eq(goals.assistantId, existing.assistantId), eq(goals.organisationId, orgId)));
            updates.isPrimary = true;
        } else if (isPrimary === false) {
            updates.isPrimary = false;
        }

        const [updated] = await db.update(goals).set(updates).where(eq(goals.id, Number(id))).returning();
        await recompileAfterGoalChange(existing.assistantId, userId, 'update');
        return json(200, { goal: updated });
    }

    // ── DELETE — remove a goal ───────────────────────────────────────────────
    if (method === 'DELETE') {
        const id = Number(params.id);
        if (!id || Number.isNaN(id)) return json(400, { error: 'id is required.' });

        const [existing] = await db.select({ orgId: goals.organisationId, assistantId: goals.assistantId })
            .from(goals).where(eq(goals.id, id)).limit(1);
        if (!existing || existing.orgId !== orgId) return json(404, { error: 'Goal not found.' });

        await db.delete(goals).where(eq(goals.id, id));
        // Recompile so a deleted goal stops steering generation immediately.
        await recompileAfterGoalChange(existing.assistantId, userId, 'delete');
        return json(200, { deleted: true, id });
    }

    return json(405, { error: 'Method Not Allowed' });
});
