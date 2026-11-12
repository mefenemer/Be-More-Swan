/**
 * src/utils/system-map.ts — the System Map's shared rules (docs/system-map-plan.md). Pure, no DB.
 *
 * ai_usage_log records every paid call by `model` (a Claude id, a fal endpoint, 'serper-search',
 * 'remotion-lambda'…). The map groups spend by SYSTEM — the keys in
 * src/utils/system-registry.ts SERVICES — so this says which system each logged model
 * belongs to. tests/system-map.test.ts fails when a model the code prices maps to nothing, so a new
 * provider can't silently drop out of the per-system totals.
 */

/** Ordered rules: the first that matches wins. Keys are system-registry.ts SERVICES keys. */
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

// ── Assembling the map (Phase 2) ────────────────────────────────────────────────────────────────
// Pure: the loader (src/utils/system-map-data.ts) runs the queries and hands the rows here, so the
// money maths is tested without a database. Everything comes out in GBP, converted at the same
// platform_config fx_rates_to_gbp the COGS report uses, and the rate is returned with it.

export interface UsageRow { model: string; usdAll: number; usd30: number; calls30: number; callsAll: number; firstAt: string | null }
export interface FixedCostRow { id: number; systemKey: string; label: string; amountMonthly: number; currency: string; startedOn: string; endedOn: string | null; note: string }
export interface StatusService { key: string; name: string; category: string; tier: string; health: string; configured: boolean | null; [k: string]: unknown }

export interface MapInput {
    status: { environment: string; runtime: unknown; readiness: unknown; services: StatusService[] };
    usage: UsageRow[];
    rolesByModel30: Record<string, string[]>;      // model → role keys that used it in 30 days
    configuredRoleModels: Record<string, string>;   // role key → model chosen in Admin ▸ Assistants
    fixed: FixedCostRow[];
    tasks: { all: number; d30: number; firstAt: string | null };
    fx: Record<string, number>;                     // currency → GBP per unit (USD 0.787…)
    fxFromConfig: boolean;
    now: Date;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a < b ? a : b));

export function toGbp(amount: number, currency: string, fx: Record<string, number>): number {
    const c = currency.toUpperCase();
    return c === 'GBP' ? amount : amount * (fx[c] ?? 0);
}

export function assembleSystemMap(input: MapInput) {
    const { fx, now } = input;
    const usdGbp = fx.USD ?? 0;
    const since30 = new Date(now.getTime() - 30 * 86_400_000);
    const roleModelsFor = (model: string) => Object.entries(input.configuredRoleModels).filter(([, m]) => m === model).map(([r]) => r).sort();

    const models = input.usage.map((u) => ({
        model: u.model,
        system: systemForUsageModel(u.model),
        spend30Gbp: r2(u.usd30 * usdGbp),
        spendAllGbp: r2(u.usdAll * usdGbp),
        calls30: u.calls30,
        callsAll: u.callsAll,
        firstAt: u.firstAt,
        roles30: (input.rolesByModel30[u.model] ?? []).slice().sort(),
        chosenFor: roleModelsFor(u.model),
    }));
    // A model chosen for a role but not used yet still belongs on the map.
    for (const m of new Set(Object.values(input.configuredRoleModels))) {
        if (!models.some((x) => x.model === m)) {
            models.push({ model: m, system: systemForUsageModel(m), spend30Gbp: 0, spendAllGbp: 0, calls30: 0, callsAll: 0, firstAt: null, roles30: [], chosenFor: roleModelsFor(m) });
        }
    }

    const systems = input.status.services.map((s) => {
        const mine = models.filter((m) => m.system === s.key).sort((a, b) => b.spendAllGbp - a.spendAllGbp);
        const bills = input.fixed.filter((f) => f.systemKey === s.key);
        const fixed30 = bills.reduce((t, b) => t + toGbp(fixedCostForPeriod(b, since30, now), b.currency, fx), 0);
        const fixedAll = bills.reduce((t, b) => t + toGbp(fixedCostForPeriod(b, new Date(`${b.startedOn}T00:00:00Z`), now), b.currency, fx), 0);
        const var30 = mine.reduce((t, m) => t + m.spend30Gbp, 0);
        const varAll = mine.reduce((t, m) => t + m.spendAllGbp, 0);
        const since = [...mine.map((m) => m.firstAt), ...bills.map((b) => b.startedOn)].reduce<string | null>((a, b) => earliest(a, b), null);
        return {
            ...s,
            spend: {
                variable30Gbp: r2(var30), variableAllGbp: r2(varAll),
                fixed30Gbp: r2(fixed30), fixedAllGbp: r2(fixedAll),
                total30Gbp: r2(var30 + fixed30), totalAllGbp: r2(varAll + fixedAll),
                calls30: mine.reduce((t, m) => t + m.calls30, 0),
                since,
            },
            models: mine,
            fixedCosts: bills,
        };
    });

    const spend30 = systems.reduce((t, s) => t + s.spend.total30Gbp, 0);
    const spendAll = systems.reduce((t, s) => t + s.spend.totalAllGbp, 0);
    const unmapped = models.filter((m) => !m.system || !systems.some((s) => s.key === m.system));
    const unmapped30 = unmapped.reduce((t, m) => t + m.spend30Gbp, 0);
    const unmappedAll = unmapped.reduce((t, m) => t + m.spendAllGbp, 0);
    const since = systems.map((s) => s.spend.since).reduce<string | null>((a, b) => earliest(a, b), null);

    return {
        environment: input.status.environment,
        runtime: input.status.runtime,
        readiness: input.status.readiness,
        currency: 'GBP' as const,
        fx: { usdToGbp: usdGbp, fromConfig: input.fxFromConfig },
        totals: {
            spend30Gbp: r2(spend30 + unmapped30),
            spendAllGbp: r2(spendAll + unmappedAll),
            spendSince: since,
            tasks30: input.tasks.d30,
            tasksAll: input.tasks.all,
            tasksSince: input.tasks.firstAt,
            costPerTask30Gbp: input.tasks.d30 > 0 ? Math.round(((spend30 + unmapped30) / input.tasks.d30) * 10000) / 10000 : null,
            systemsDown: systems.filter((s) => s.health === 'error').length,
            notConfigured: systems.filter((s) => s.configured === false && s.tier !== 'connector').length,
        },
        systems,
        unmappedModels: unmapped,   // spend we couldn't place under a system — counted in the totals, flagged
        generatedAt: now.toISOString(),
    };
}

export type SystemMap = ReturnType<typeof assembleSystemMap>;

// ── Fixed bills: one validator for the page and the chat's cards ────────────────────────────────
export const FIXED_COST_CURRENCIES = ['GBP', 'USD', 'EUR'] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: unknown): d is string => typeof d === 'string' && ISO_DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

export type FixedCostRequest =
    | { action: 'add_fixed'; systemKey: string; label: string; amountMonthly: number; currency: string; startedOn: string; endedOn: string | null; note: string }
    | { action: 'end_fixed'; id: number; endedOn: string }
    | { action: 'delete_fixed'; id: number };

/** Checks a fixed-bill request. Returns the cleaned request, or a sentence saying what's wrong. Pure. */
export function validateFixedCostRequest(body: Record<string, unknown>, knownSystemKeys: string[]): { ok: FixedCostRequest } | { error: string } {
    const action = body.action;
    if (action === 'add_fixed') {
        const systemKey = String(body.systemKey ?? '');
        if (!knownSystemKeys.includes(systemKey)) return { error: 'Pick a system from the map.' };
        const amount = Number(body.amountMonthly);
        if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) return { error: 'Enter the monthly amount as a number, e.g. 19.00.' };
        const currency = String(body.currency ?? 'GBP').toUpperCase();
        if (!(FIXED_COST_CURRENCIES as readonly string[]).includes(currency)) return { error: 'Currency must be GBP, USD or EUR.' };
        if (!validDay(body.startedOn)) return { error: 'Enter the date the bill started, as YYYY-MM-DD.' };
        const endedOn = body.endedOn == null || body.endedOn === '' ? null : body.endedOn;
        if (endedOn !== null && (!validDay(endedOn) || endedOn < (body.startedOn as string))) return { error: 'The end date must be a date on or after the start.' };
        return { ok: {
            action, systemKey, amountMonthly: Math.round(amount * 100) / 100, currency, startedOn: body.startedOn as string, endedOn: endedOn as string | null,
            label: String(body.label ?? '').trim().slice(0, 80), note: String(body.note ?? '').trim().slice(0, 500),
        } };
    }
    if (action === 'end_fixed' || action === 'delete_fixed') {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) return { error: 'That bill was not found.' };
        if (action === 'delete_fixed') return { ok: { action, id } };
        if (!validDay(body.endedOn)) return { error: 'Enter the last day paid, as YYYY-MM-DD.' };
        return { ok: { action, id, endedOn: body.endedOn as string } };
    }
    return { error: 'Unknown action.' };
}
