// src/config/discovery-limits.ts
// The ceilings that stand between a tenant's Searches tab and our search bill.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// The per-campaign guardrails (discovery_guardrails) were the only limits in the system, and two
// holes ran straight through them:
//
//  1. **The volume fields were taken from the request body unclamped.** `maxLeadsPerRun` and
//     `maxLeadsPerMonth` arrived as `typeof x === 'number'` and went into the column. A form that
//     posted 100000, a chat proposal that invented a big number, or anyone with the browser console
//     open, could raise a tenant's own ceiling to whatever they liked. `maxCostGbpPerRun` was
//     already protected by never being accepted at all — these two were not.
//
//  2. **Nothing limited how many campaigns an org could run.** Each is separately capped at
//     £2/run, so the real ceiling was £2 × active searches × runs per day. A tenant with twenty
//     daily searches is a £40/day search bill against a plan that meters chat turns and not one
//     search call.
//
// The numbers here are deliberately generous — they are anti-runaway limits, not a product tier. A
// user who hits one is doing something unusual and gets told so in plain words, rather than
// discovering it as a run that quietly stopped early.
//
// ⚠️ These are OUR ceilings on OUR spend, in the same family as `maxCostGbpPerRun`, which is why
// they live in code and not in a settings screen. If they ever become plan-differentiated, resolve
// them per plan HERE and keep the call sites reading one function.

/** Hard ceiling on `discovery_guardrails.max_leads_per_run`, whatever the caller asks for. */
export const MAX_LEADS_PER_RUN_CEILING = 200;

/** Hard ceiling on `discovery_guardrails.max_leads_per_month`. */
export const MAX_LEADS_PER_MONTH_CEILING = 2000;

/**
 * How many searches one organisation may have running at once (`status = 'active'`).
 *
 * Counted per ORG, not per assistant: the spend is ours and the mailbox limits downstream
 * (MAX_SENDS_PER_ORG_PER_DAY) are already per org, so a per-assistant cap would be trivially
 * sidestepped by hiring a second Lead Generator.
 *
 * Drafts and paused searches do not count — neither spends anything, and a tenant refining ten
 * ideas before starting one is exactly the behaviour we want.
 */
export const MAX_ACTIVE_CAMPAIGNS_PER_ORG = 10;

/**
 * Clamp a caller-supplied guardrail value into (0, ceiling].
 *
 * Returns undefined for anything that is not a usable positive number, which the callers spread as
 * "leave the column at its table default" — the same shape they already used. A zero or negative
 * value is dropped rather than clamped to 1: it is not a small limit, it is a mistake, and a search
 * that finds one lead per run would look broken.
 */
export function clampGuardrail(value: unknown, ceiling: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const n = Math.floor(value);
    if (n < 1) return undefined;
    return Math.min(n, ceiling);
}
