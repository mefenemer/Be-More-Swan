/**
 * src/utils/system-map.ts — the System Map's shared rules (docs/system-map-plan.md). Pure, no DB.
 *
 * ai_usage_log records every paid call by `model` (a Claude id, a fal endpoint, 'serper-search',
 * 'remotion-lambda'…). The map groups spend by SYSTEM — the keys in
 * netlify/functions/admin-system-status.ts SERVICES — so this says which system each logged model
 * belongs to. tests/system-map.test.ts fails when a model the code prices maps to nothing, so a new
 * provider can't silently drop out of the per-system totals.
 */

/** Ordered rules: the first that matches wins. Keys are admin-system-status.ts SERVICES keys. */
const RULES: Array<{ system: string; test: (model: string) => boolean }> = [
    { system: 'anthropic', test: (m) => m.startsWith('claude-') },
    { system: 'fal', test: (m) => m.startsWith('fal-ai/') },
    { system: 'stability', test: (m) => m.startsWith('stable-audio') },
    { system: 'embeddings', test: (m) => m.startsWith('voyage-') },
    { system: 'elevenlabs', test: (m) => m.startsWith('eleven_') },
    { system: 'openai', test: (m) => /^(gpt-|whisper-|omni-moderation|text-moderation|text-embedding-|tts-|o\d)/.test(m) },
    { system: 'gemini', test: (m) => m.startsWith('gemini-') },
    { system: 'serper', test: (m) => m.startsWith('serper-') },
    { system: 'hunter', test: (m) => m.startsWith('hunter-') },
    { system: 'remotion', test: (m) => m === 'remotion-lambda' },
];

/** The system a logged ai_usage_log.model belongs to, or null when no rule knows it. */
export function systemForUsageModel(model: string | null | undefined): string | null {
    const m = String(model ?? '').trim().toLowerCase();
    if (!m) return null;
    return RULES.find((r) => r.test(m))?.system ?? null;
}

/**
 * What a fixed monthly bill cost over [from, to): whole months pro-rated by day (30.44-day month),
 * clipped to when the bill ran. Pure. `endedOn` null = still paying.
 */
export function fixedCostForPeriod(
    bill: { amountMonthly: number; startedOn: string; endedOn: string | null },
    from: Date,
    to: Date,
): number {
    const start = new Date(`${bill.startedOn}T00:00:00Z`).getTime();
    // An end date is the last day paid, so the bill runs to the END of that day.
    const end = bill.endedOn ? new Date(`${bill.endedOn}T00:00:00Z`).getTime() + 86_400_000 : Infinity;
    const lo = Math.max(start, from.getTime());
    const hi = Math.min(end, to.getTime());
    if (!(hi > lo) || !(bill.amountMonthly > 0)) return 0;
    const days = (hi - lo) / 86_400_000;
    return Math.round((bill.amountMonthly * days / 30.44) * 100) / 100;
}
