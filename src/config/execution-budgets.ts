// src/config/execution-budgets.ts
// US-GOV-4.1.1: the per-run execution ceilings, and the one place they are defined.
//
// These lived inside netlify/functions/execution-budget.ts, which meant the blueprint could not
// import them without a src → netlify/functions dependency. So blueprint.ts described the budget
// from scratch and got it wrong in two ways at once: it read the values from the TOP level of
// ai_assistants.configuration when the enforcer reads them NESTED under `.budget`, and it reported
// "missing" when an assistant had none — even though a run with no per-assistant budget is not
// unbudgeted, it runs on WORKSPACE_DEFAULTS below. Same failure mode as OPERATIONAL_TRIGGERS
// (src/utils/operational-setup.ts): two copies of one contract, drifting silently.

/** Where a per-assistant budget is stored on ai_assistants.configuration. */
export const BUDGET_CONFIG_KEY = 'budget' as const;

export interface BudgetConfig {
    maxLlmCalls: number;
    maxToolCalls: number;
    maxTokensGenerated: number;
    maxWallClockMinutes: number;
    maxCostGbp: number;
}

/** Absolute ceilings. Overridable by platform_config key 'execution_budget_limits'. */
export const PLATFORM_DEFAULTS: BudgetConfig = {
    maxLlmCalls: 200,
    maxToolCalls: 500,
    maxTokensGenerated: 200_000,
    maxWallClockMinutes: 60,
    maxCostGbp: 10.00,
};

/** What a run gets when the assistant carries no budget of its own — which is currently all of them. */
export const WORKSPACE_DEFAULTS: BudgetConfig = {
    maxLlmCalls: 50,
    maxToolCalls: 100,
    maxTokensGenerated: 50_000,
    maxWallClockMinutes: 15,
    maxCostGbp: 1.50,
};

/** An assistant's budget can only ever lower the platform ceiling, never raise it. */
export function clampToPlatform(
    workspace: Partial<BudgetConfig>,
    platform: Partial<BudgetConfig>,
): BudgetConfig {
    const p = { ...PLATFORM_DEFAULTS, ...platform };
    const w = { ...WORKSPACE_DEFAULTS, ...workspace };
    return {
        maxLlmCalls: Math.min(w.maxLlmCalls, p.maxLlmCalls),
        maxToolCalls: Math.min(w.maxToolCalls, p.maxToolCalls),
        maxTokensGenerated: Math.min(w.maxTokensGenerated, p.maxTokensGenerated),
        maxWallClockMinutes: Math.min(w.maxWallClockMinutes, p.maxWallClockMinutes),
        maxCostGbp: Math.min(w.maxCostGbp, p.maxCostGbp),
    };
}

/**
 * The budget an assistant actually runs under, and where each half came from. `explicit` is false
 * when the assistant carries no `configuration.budget` — the ceilings still apply, they are just
 * the shared defaults rather than anything a human chose for this assistant.
 */
export function resolveBudget(
    configuration: Record<string, unknown> | null | undefined,
    platformLimits: Partial<BudgetConfig> = {},
): { budget: BudgetConfig; explicit: boolean } {
    const raw = (configuration as Record<string, unknown> | null)?.[BUDGET_CONFIG_KEY];
    const workspace = (raw && typeof raw === 'object') ? raw as Partial<BudgetConfig> : {};
    return {
        budget: clampToPlatform(workspace, platformLimits),
        explicit: Object.keys(workspace).length > 0,
    };
}
