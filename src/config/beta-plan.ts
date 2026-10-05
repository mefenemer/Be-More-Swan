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

export function featureTierKey<T extends string | null | undefined>(tierKey: T): T | typeof BETA_FEATURES_AS {
    return tierKey === BETA_TIER_KEY ? BETA_FEATURES_AS : tierKey;
}
