// netlify/functions/execution-budget.ts
// US-GOV-4.1.1: Hard execution budgets per agent run.
//
// GET  ?taskRunId=N              — budget report: actual vs ceiling for a run
// POST { taskRunId, metrics }   — agent heartbeat: enforce budget ceilings, trigger suspension
// PATCH { taskRunId, action, newBudget?, acknowledgement? } — resume | resume_with_budget | cancel
//
// Budget config lives in aiAssistants.configuration.budget (per-assistant).
// Platform hard maximums live in platformConfig key 'execution_budget_limits'.
//
// Default ceilings (also used when assistant has no budget config):
//   maxLlmCalls: 50        (platform hard max: 200)
//   maxToolCalls: 100       (platform hard max: 500)
//   maxTokensGenerated: 50000 (platform hard max: 200000)
//   maxWallClockMinutes: 15  (platform hard max: 60)
//   maxCostGbp: 1.50         (platform hard max: 10.00)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, platformConfig, taskRuns } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { withLambda } from '@netlify/aws-lambda-compat';
// Single source of truth, shared with the blueprint's section 10 — see src/config/execution-budgets.ts
// for why these no longer live here.
import {
    type BudgetConfig,
    WORKSPACE_DEFAULTS,
    clampToPlatform,
} from '../../src/config/execution-budgets';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): { userId: number } | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try {
        return { userId: (jwt.verify(match[1], jwtSecret) as { userId: number }).userId };
    } catch {
        return null;
    }
}

export default withLambda(async (event) => {
    const auth = getAuth(event);
    if (!auth) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── GET — budget report ───────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const taskRunId = parseInt(event.queryStringParameters?.taskRunId || '');
        if (!taskRunId) return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId is required.' }) };

        const [run] = await db
            .select()
            .from(taskRuns)
            .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, auth.userId)))
            .limit(1);

        if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };

        const budget = (run.budgetSnapshot as BudgetConfig | null) ?? WORKSPACE_DEFAULTS;
        const wallClockMinutes = run.wallClockStartedAt
            ? (Date.now() - new Date(run.wallClockStartedAt).getTime()) / 60_000
            : 0;

        const costGbp = parseFloat(run.costGbp as unknown as string ?? '0');

        const actual = {
            llmCallCount: run.llmCallCount,
            toolCallCount: run.toolCallCount,
            tokensGenerated: run.tokensUsed ?? 0,
            wallClockMinutes: Math.round(wallClockMinutes * 100) / 100,
            costGbp,
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                taskRunId,
                status: run.status,
                suspendReason: run.suspendReason ?? null,
                budget,
                actual,
                utilisation: {
                    llmCalls: budget.maxLlmCalls > 0 ? actual.llmCallCount / budget.maxLlmCalls : 0,
                    toolCalls: budget.maxToolCalls > 0 ? actual.toolCallCount / budget.maxToolCalls : 0,
                    tokens: budget.maxTokensGenerated > 0 ? actual.tokensGenerated / budget.maxTokensGenerated : 0,
                    wallClock: budget.maxWallClockMinutes > 0 ? actual.wallClockMinutes / budget.maxWallClockMinutes : 0,
                    cost: budget.maxCostGbp > 0 ? actual.costGbp / budget.maxCostGbp : 0,
                },
            }),
        };
    }

    // ── POST — heartbeat / budget enforcement ─────────────────────────────────
    if (event.httpMethod === 'POST') {
        let body: {
            taskRunId?: number;
            metrics?: {
                llmCallCount?: number;
                toolCallCount?: number;
                tokensGenerated?: number;
                costGbp?: number;
            };
        } = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { taskRunId, metrics = {} } = body;
        if (!taskRunId) return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId is required.' }) };

        const [run] = await db
            .select({ id: taskRuns.id, status: taskRuns.status, assistantId: taskRuns.assistantId, userId: taskRuns.userId, wallClockStartedAt: taskRuns.wallClockStartedAt, budgetSnapshot: taskRuns.budgetSnapshot, costGbp: taskRuns.costGbp })
            .from(taskRuns)
            .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, auth.userId)))
            .limit(1);

        if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };
        if (run.status === 'suspended' || run.status === 'terminated') {
            return { statusCode: 200, body: JSON.stringify({ shouldSuspend: true, suspendReason: run.status }) };
        }

        // Resolve effective budget (snapshot or derive fresh)
        let budget: BudgetConfig;
        if (run.budgetSnapshot) {
            budget = run.budgetSnapshot as BudgetConfig;
        } else {
            // Load platform limits
            const [platformRow] = await db
                .select({ value: platformConfig.value })
                .from(platformConfig)
                .where(eq(platformConfig.key, 'execution_budget_limits'))
                .limit(1);
            const platformLimits = (platformRow?.value ?? {}) as Partial<BudgetConfig>;

            // Load assistant budget config
            let workspaceBudget: Partial<BudgetConfig> = {};
            if (run.assistantId) {
                const [assistant] = await db
                    .select({ configuration: aiAssistants.configuration })
                    .from(aiAssistants)
                    .where(eq(aiAssistants.id, run.assistantId))
                    .limit(1);
                workspaceBudget = (assistant?.configuration as any)?.budget ?? {};
            }

            budget = clampToPlatform(workspaceBudget, platformLimits);

            // Persist snapshot so resume uses same budget
            await db.update(taskRuns)
                .set({ budgetSnapshot: budget, wallClockStartedAt: run.wallClockStartedAt ?? new Date() })
                .where(eq(taskRuns.id, taskRunId));
        }

        // Update counters
        const newLlmCalls = metrics.llmCallCount ?? 0;
        const newToolCalls = metrics.toolCallCount ?? 0;
        const newTokens = metrics.tokensGenerated ?? 0;
        const newCostGbp = metrics.costGbp ?? 0;
        const wallClockMinutes = run.wallClockStartedAt
            ? (Date.now() - new Date(run.wallClockStartedAt).getTime()) / 60_000
            : 0;

        await db.update(taskRuns)
            .set({
                llmCallCount: newLlmCalls,
                toolCallCount: newToolCalls,
                tokensUsed: newTokens,
                costGbp: newCostGbp.toFixed(6) as unknown as any,
            })
            .where(eq(taskRuns.id, taskRunId));

        // Check ceilings
        let suspendReason: string | null = null;
        if (newLlmCalls >= budget.maxLlmCalls) suspendReason = 'max_llm_calls';
        else if (newToolCalls >= budget.maxToolCalls) suspendReason = 'max_tool_calls';
        else if (newTokens >= budget.maxTokensGenerated) suspendReason = 'max_tokens';
        else if (wallClockMinutes >= budget.maxWallClockMinutes) suspendReason = 'max_wall_clock';
        else if (newCostGbp >= budget.maxCostGbp) suspendReason = 'max_cost';

        if (suspendReason) {
            await db.update(taskRuns)
                .set({ status: 'suspended', suspendReason })
                .where(eq(taskRuns.id, taskRunId));

            // Notify the run owner immediately
            await createNotification(db, 'run_budget_suspended', {
                userId: run.userId,
                context: { run: { id: taskRunId, suspend_reason: suspendReason.replace(/_/g, ' ') } },
                isRead: false,
            });

            return { statusCode: 200, body: JSON.stringify({ shouldSuspend: true, suspendReason }) };
        }

        // 80% cost warning
        let warningType: string | null = null;
        const prevCostGbp = parseFloat(run.costGbp as unknown as string ?? '0');
        const costPct = newCostGbp / budget.maxCostGbp;
        const prevCostPct = prevCostGbp / budget.maxCostGbp;
        if (costPct >= 0.8 && prevCostPct < 0.8) {
            warningType = 'cost_80pct';
            await createNotification(db, 'run_cost_warning', {
                userId: run.userId,
                context: { run: {
                    id: taskRunId,
                    cost: newCostGbp.toFixed(4),
                    budget: budget.maxCostGbp.toFixed(2),
                    pct: Math.round(costPct * 100),
                } },
                isRead: false,
            });
        }

        return { statusCode: 200, body: JSON.stringify({ shouldSuspend: false, warningType }) };
    }

    // ── PATCH — resume / resume_with_budget / cancel ──────────────────────────
    if (event.httpMethod === 'PATCH') {
        let body: {
            taskRunId?: number;
            action?: 'resume' | 'resume_with_budget' | 'cancel';
            newBudget?: Partial<BudgetConfig>;
            acknowledgement?: string;
        } = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { taskRunId, action, newBudget, acknowledgement } = body;
        if (!taskRunId) return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId is required.' }) };
        if (!action || !['resume', 'resume_with_budget', 'cancel'].includes(action)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'action must be resume, resume_with_budget, or cancel.' }) };
        }

        const [run] = await db
            .select({ id: taskRuns.id, status: taskRuns.status, userId: taskRuns.userId, budgetSnapshot: taskRuns.budgetSnapshot, assistantId: taskRuns.assistantId })
            .from(taskRuns)
            .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, auth.userId)))
            .limit(1);

        if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Run not found.' }) };
        if (run.status !== 'suspended') {
            return { statusCode: 409, body: JSON.stringify({ error: `Run is in '${run.status}' state — only suspended runs can be acted on.` }) };
        }

        if (action === 'cancel') {
            await db.update(taskRuns)
                .set({ status: 'terminated', suspendReason: 'cancelled_by_user' })
                .where(eq(taskRuns.id, taskRunId));
            return { statusCode: 200, body: JSON.stringify({ status: 'terminated' }) };
        }

        if (action === 'resume_with_budget') {
            if (!newBudget) return { statusCode: 400, body: JSON.stringify({ error: 'newBudget is required for resume_with_budget.' }) };
            if (!acknowledgement?.trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'acknowledgement is required when increasing the budget.' }) };
            }

            // Load platform limits and clamp new budget
            const [platformRow] = await db
                .select({ value: platformConfig.value })
                .from(platformConfig)
                .where(eq(platformConfig.key, 'execution_budget_limits'))
                .limit(1);
            const platformLimits = (platformRow?.value ?? {}) as Partial<BudgetConfig>;
            const currentBudget = (run.budgetSnapshot as BudgetConfig | null) ?? WORKSPACE_DEFAULTS;
            const merged = { ...currentBudget, ...newBudget };
            const clamped = clampToPlatform(merged, platformLimits);

            await db.update(taskRuns)
                .set({ status: 'completed', suspendReason: null, budgetSnapshot: clamped })
                .where(eq(taskRuns.id, taskRunId));

            return { statusCode: 200, body: JSON.stringify({ status: 'resumed', budget: clamped }) };
        }

        // resume (same budget)
        await db.update(taskRuns)
            .set({ status: 'completed', suspendReason: null })
            .where(eq(taskRuns.id, taskRunId));

        return { statusCode: 200, body: JSON.stringify({ status: 'resumed', budget: run.budgetSnapshot ?? WORKSPACE_DEFAULTS }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
