/**
 * src/utils/ai-usage.ts
 *
 * US-ADM-3.1.1: AI Token Usage Logging & COGS Dashboard
 *
 * Fire-and-forget utility to log one AI call to ai_usage_log.
 * costUsd is calculated server-side from aiModelPricing rates. A model with no pricing row falls
 * back to LIST_PRICE_PER_1K below — it used to be stored as $0, and nothing seeds ai_model_pricing,
 * so a fresh environment recorded every call as free and the COGS dashboard read £0 margin-cost for
 * every workspace. A row in ai_model_pricing still wins, so an admin can correct a rate without a
 * deploy.
 */

import { getDb } from '../../db/client';
import { aiUsageLog, aiModelPricing, aiAssistants } from '../../db/schema';
import { eq } from 'drizzle-orm';

// US-GDPR-4.2.2: valid data category labels
export type DataCategory =
    | 'general'
    | 'business_context'
    | 'pii_redacted'
    | 'special_category_suspected'
    | 'financial'
    | 'health';

/**
 * Anthropic list prices, USD per 1,000 tokens (input, output). Keyed on the exact model strings the
 * code calls — the gateway and every direct caller log the constant they invoked, not the dated id
 * the API echoes back. A model missing from here AND from ai_model_pricing still records $0, so add
 * a line when a new model goes into use.
 */
export const LIST_PRICE_PER_1K: Record<string, { input: number; output: number }> = {
    'claude-sonnet-4-6':         { input: 0.003, output: 0.015 },
    'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
    'claude-haiku-4-5':          { input: 0.001, output: 0.005 },
};

/** Cost of one call in USD, as a 6-dp string. Pure — the rate lookup is the caller's. */
export function costUsdFor(inputTokens: number, outputTokens: number, rate: { input: number; output: number } | null): string {
    if (!rate) return '0';
    return ((inputTokens / 1000) * rate.input + (outputTokens / 1000) * rate.output).toFixed(6);
}

export interface AiUsageParams {
    workspaceId?: number | null;
    userId?: number | null;
    assistantId?: number | null;
    model: string;               // must match aiModelPricing.modelKey, e.g. 'gpt-4o-mini'
    inputTokens: number;
    outputTokens: number;
    taskRunId?: number | null;
    sessionId?: string | null;
    // US-GDPR-4.2.2: data categories present in the prompt. Defaults to ['general'].
    dataCategories?: DataCategory[];
}

/**
 * Write one row to ai_usage_log.
 * Non-blocking — call with `void logAiUsage(...)` or wrap in setImmediate.
 * Never throws; errors are logged to console only.
 */
export async function logAiUsage(params: AiUsageParams): Promise<void> {
    try {
        const db = getDb();

        // Look up per-token pricing for this model; the list price when there is no row.
        const [pricing] = await db
            .select({
                inputCostPer1kTokens:  aiModelPricing.inputCostPer1kTokens,
                outputCostPer1kTokens: aiModelPricing.outputCostPer1kTokens,
            })
            .from(aiModelPricing)
            .where(eq(aiModelPricing.modelKey, params.model))
            .limit(1);

        const rate = pricing
            ? { input: parseFloat(pricing.inputCostPer1kTokens), output: parseFloat(pricing.outputCostPer1kTokens) }
            : LIST_PRICE_PER_1K[params.model] ?? null;
        const costUsd = costUsdFor(params.inputTokens, params.outputTokens, rate);

        // A caller that knows only the assistant (the quality reviewer, for one) still belongs to a
        // workspace, and the COGS dashboard groups by workspace — an unattributed row is a cost
        // charged to nobody's margin.
        let workspaceId = params.workspaceId ?? null;
        if (workspaceId == null && params.assistantId) {
            const [a] = await db.select({ orgId: aiAssistants.organisationId }).from(aiAssistants)
                .where(eq(aiAssistants.id, params.assistantId)).limit(1);
            workspaceId = a?.orgId ?? null;
        }

        await db.insert(aiUsageLog).values({
            workspaceId,
            userId:         params.userId       ?? null,
            assistantId:    params.assistantId  ?? null,
            model:          params.model,
            inputTokens:    params.inputTokens,
            outputTokens:   params.outputTokens,
            costUsd,
            taskRunId:      params.taskRunId    ?? null,
            sessionId:      params.sessionId    ?? null,
            dataCategories: params.dataCategories?.length ? params.dataCategories : ['general'],
        });
    } catch (err) {
        console.error('[ai-usage] Failed to write usage log row:', err);
        // Never re-throw — logging failure must not block the AI response
    }
}

/**
 * Record a direct Anthropic SDK call (one that does not go through src/lib/ai-gateway.ts, which
 * records its own). Pass the response as returned and the model constant you CALLED — not
 * `response.model`, which is the dated id the API echoes and matches no price. Fire-and-forget:
 * never throws, never needs awaiting.
 */
export function logMessageUsage(
    response: { usage?: { input_tokens?: number | null; output_tokens?: number | null } | null } | null | undefined,
    model: string,
    ctx: Omit<AiUsageParams, 'model' | 'inputTokens' | 'outputTokens'> = {},
): void {
    if (!response?.usage) return;
    void logAiUsage({
        ...ctx,
        model,
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
    });
}
