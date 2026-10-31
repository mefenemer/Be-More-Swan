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
    // Partner Ops admin chat (admin-partners-chat.ts), and its refusal fallback.
    'claude-opus-5-5':           { input: 0.004, output: 0.02 },
    'claude-opus-4-8':           { input: 0.005, output: 0.025 },
    'claude-sonnet-4-6':         { input: 0.003, output: 0.015 },
    // Choosable per assistant role (src/config/model-options.ts) — keep the two lists in step.
    'claude-sonnet-5-5':         { input: 0.002, output: 0.01 },
    'claude-haiku-5-5':          { input: 0.0001, output: 0.0005 },
    'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
    'claude-haiku-4-5':          { input: 0.001, output: 0.005 },
    // Voyage embeddings (src/utils/kb-embeddings.ts): $0.02 per million tokens, no free tier for
    // this model (docs.voyageai.com/docs/pricing, 2026-10-13). Embeddings have no output tokens.
    'voyage-3.5-lite':           { input: 0.00002, output: 0 },
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
    /** A cost already worked out by the caller (media is priced per item, not per token). Skips
     *  the token-rate lookup entirely. */
    costUsdOverride?: string;
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
        const [pricing] = params.costUsdOverride != null ? [] : await db
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
        const costUsd = params.costUsdOverride ?? costUsdFor(params.inputTokens, params.outputTokens, rate);

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

// ── AI media (fal images and video, Stability music) ──────────────────────────────────────────────
// Priced per ITEM, not per token, so these rows carry 0 tokens and a cost worked out here. Written to
// the same ai_usage_log so the COGS dashboard's per-workspace margin includes them — before
// 2026-10-13 AI images, the likeliest second-biggest cost after drafting, were in no ledger at all.
//
// List prices as published on 2026-10-13 — check them against the provider's invoice and update:
//   • fal FLUX 1.1 Pro: $0.04 per megapixel, ROUNDED UP per image (fal's own wording), so a
//     1024×1024 image (1.05 MP) is billed as 2 MP. Rounded up here too: overstating a cost is the
//     safe error in a margin view.
//   • fal Hailuo 2.3 Standard text-to-video: $0.28 per 6 s, $0.56 per 10 s.
//   • fal Kling image-to-video (fal pricing page 2026-10-31): v2.5 Turbo Pro $0.07/s, v3 Pro $0.14/s.
//   • Stability Stable Audio 3.0: 26 credits per SUCCESSFUL track at $0.01 a credit.
export const MEDIA_LIST_PRICE_USD: Record<string, { perMegapixel?: number; perDuration?: Record<number, number>; perItem?: number }> = {
    'fal-ai/flux-pro/v1.1': { perMegapixel: 0.04 },
    // Priced per clip LENGTH, not per second: 10 s is not 10/6 of 6 s.
    'fal-ai/minimax/hailuo-2.3/standard/text-to-video': { perDuration: { 6: 0.28, 10: 0.56 } },
    'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': { perDuration: { 5: 0.35, 10: 0.70 } },
    'fal-ai/kling-video/v3/pro/image-to-video': { perDuration: { 3: 0.42, 4: 0.56, 5: 0.70, 6: 0.84, 8: 1.12, 10: 1.40, 15: 2.10 } },
    'stable-audio-3': { perItem: 0.26 },
};

/** Cost of one media generation in USD (6 dp). Pure. An unpriced model is '0'. */
export function mediaCostUsd(model: string, opts: { images?: Array<{ width?: number | null; height?: number | null }>; durationSeconds?: number | null }): string {
    const p = MEDIA_LIST_PRICE_USD[model];
    if (!p) return '0';
    let usd = 0;
    if (p.perMegapixel != null) {
        for (const img of opts.images ?? []) {
            const mp = img.width && img.height ? Math.ceil((img.width * img.height) / 1_000_000) : 1;
            usd += mp * p.perMegapixel;
        }
    }
    if (p.perDuration) {
        // An unlisted length is priced at the longest listed clip — overstating is the safe error.
        const d = opts.durationSeconds ?? 0;
        usd += p.perDuration[d] ?? Math.max(...Object.values(p.perDuration));
    }
    if (p.perItem != null) usd += p.perItem;
    return usd.toFixed(6);
}

/** Record one SUCCESSFUL media generation. Fire-and-forget: never throws, never needs awaiting. */
export function logMediaCost(
    model: string,
    opts: { images?: Array<{ width?: number | null; height?: number | null }>; durationSeconds?: number | null },
    ctx: Omit<AiUsageParams, 'model' | 'inputTokens' | 'outputTokens' | 'costUsdOverride'> = {},
): void {
    if (!MEDIA_LIST_PRICE_USD[model]) console.warn(`[ai-usage] no media price for ${model} — logged at $0; add it to MEDIA_LIST_PRICE_USD`);
    void logAiUsage({ ...ctx, model, inputTokens: 0, outputTokens: 0, costUsdOverride: mediaCostUsd(model, opts) });
}

// ── Per-call services (search, contact lookups) ───────────────────────────────────────────────────
// Neither is priced in tokens. Defaults are the providers' published prices on 2026-10-13 for the
// smallest paid tier; set the env var to your actual rate once you buy a bigger pack.
//   • Serper: $1.00 per 1,000 searches on the $50 pack (down to $0.30 on the largest).
//   • Hunter: 1 credit per EMAIL FOUND by a domain search (none if nothing is found); Starter is
//     €49 for 2,000 credits ≈ $0.0285 a credit. A domain search can return up to 10 emails, so
//     one lookup can cost up to 10 credits — the units logged are the emails Hunter returned.
export const SERVICE_UNIT_PRICE_USD: Record<string, { envVar: string; fallback: number; unit: string }> = {
    'serper-search': { envVar: 'SERPER_COST_USD_PER_QUERY', fallback: 0.001, unit: 'search' },
    'hunter-domain-search': { envVar: 'HUNTER_COST_USD_PER_CREDIT', fallback: 0.0285, unit: 'credit' },
    // Email Finder: 1 credit per address FOUND for a named person, none on a miss — the same credit.
    'hunter-email-finder': { envVar: 'HUNTER_COST_USD_PER_CREDIT', fallback: 0.0285, unit: 'credit' },
};

export function serviceUnitPriceUsd(service: string): number {
    const def = SERVICE_UNIT_PRICE_USD[service];
    if (!def) return 0;
    const raw = process.env[def.envVar];
    const fromEnv = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : def.fallback;
}

/**
 * Record a per-call service charge (a Serper search, a Hunter lookup) in ai_usage_log, so the COGS
 * view's per-workspace margin includes it. `units` is what the provider bills: searches for Serper,
 * credits (emails returned) for Hunter. Zero units records nothing. Never throws.
 */
export function logServiceCost(
    service: string,
    units: number,
    ctx: Omit<AiUsageParams, 'model' | 'inputTokens' | 'outputTokens' | 'costUsdOverride'> = {},
): void {
    if (!(units > 0)) return;
    void logAiUsage({ ...ctx, model: service, inputTokens: 0, outputTokens: 0, costUsdOverride: (units * serviceUnitPriceUsd(service)).toFixed(6) });
}
