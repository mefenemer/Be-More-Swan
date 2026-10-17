// src/config/beta-plan.ts
//
// The free 'beta' plan (db/beta-tester-plan.sql) is a copy of the top self-serve tier, 'employee'.
// Its LIMITS come from its own master_plans row — but a lot of code gates features on the tier KEY
// itself ('employee' in a list, a TIER_ORDER rank, VIDEO_TIERS…). Unknown to all of them, 'beta'
// fell out differently in each: some treated it as the top tier, some as below the entry plan.
//
// featureTierKey() is the one answer: for any FEATURE decision, beta behaves as 'employee'. Billing
// keeps the real key ('beta') so the plan is still shown and handled as what it is.
//
// No imports on purpose — used by Netlify functions and by small utils alike.

export const BETA_TIER_KEY = 'beta';
/** The tier whose features a beta tester gets. Keep in step with db/beta-tester-plan.sql's source row. */
export const BETA_FEATURES_AS = 'employee';

// The free 14-day trial (src/utils/trial.ts, db/z-trial-plan.sql), owner decision 2026-10-17: the
// £79 Busywork Buster's features — every assistant — with a small task allowance. Same problem as
// beta: code that gates on the tier KEY must read it as 'buster'.
export const TRIAL_TIER_KEY = 'trial';
export const TRIAL_FEATURES_AS = 'buster';

/** plans.plan_type values for the free, card-less plans. A paid plan REPLACES either of them. */
export const FREE_PLAN_TYPES = ['beta', 'trial'] as const;

export function featureTierKey<T extends string | null | undefined>(tierKey: T): T | typeof BETA_FEATURES_AS | typeof TRIAL_FEATURES_AS {
    if (tierKey === BETA_TIER_KEY) return BETA_FEATURES_AS;
    if (tierKey === TRIAL_TIER_KEY) return TRIAL_FEATURES_AS;
    return tierKey;
}
